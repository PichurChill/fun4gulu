import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { UltraAudio } from './audio'
import { BattleEffects } from './effects'
import { WINDUP_TIME } from './encounter'
import type { EncounterEvent, Impact } from './encounter'
import { ArenaManager } from './environment'
import { UltraGestureRecognizer } from './gesture'
import { canTrackFeet, JumpKickRecognizer } from './jump'
import { HERO_PROFILES } from './heroes'
import { HeroController } from './hero'
import type { HeroFormSpec, HeroId, HeroProfile } from './heroes'
import { KaijuController, MONSTER_WAVES } from './monsters'
import type {
  BattleHudState,
  ConcreteSceneTheme,
  ControlMode,
  FloatingDamageEvent,
  GamePhase,
  MonsterAttackKind,
  PoseLandmark,
  SceneTheme,
} from './types'

export interface EngineCallbacks {
  onHudUpdate: (state: BattleHudState) => void
  onFloatingText: (evt: FloatingDamageEvent) => void
}

const DISC_MAX_COOLDOWN = 1.5
const BEAM_MAX_COOLDOWN = 1.9

/**
 * 奥特曼 3D 全身体感超激斗主引擎：
 * - 菜单正面英雄仰拍特写 -> 开战一镜到底甩至越肩对峙机位（窄屏/分屏自适应防裁切）
 * - 近身踏步搏击、三段重拳、火球挥拳弹反、精准防御破防、宿命双光线对波角力
 */
export class UltramanGameEngine {
  private readonly container: HTMLElement
  private readonly callbacks: EngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly loader = new GLTFLoader()

  public readonly audio = new UltraAudio()
  private feetTracked = false
  private readonly jump = new JumpKickRecognizer()
  private readonly gesture = new UltraGestureRecognizer()
  private readonly arena: ArenaManager
  private readonly hero: HeroController
  private readonly kaiju: KaijuController
  private readonly effects: BattleEffects

  private rafId = 0
  private lastTimestamp = 0
  private elapsedTime = 0
  private disposed = false
  private baseAssets: Promise<void> | null = null
  private assetsReady = false

  // 游戏核心状态机
  private phase: GamePhase = 'menu'
  private heroProfile: HeroProfile = HERO_PROFILES.tiga
  private heroFormIndex = 0
  private controlMode: ControlMode = 'camera'
  private preferredTheme: SceneTheme = 'auto'
  private loadingProgress = 0
  private waveIndex = 0
  private monsterHp = 340
  private monsterMaxHp = 340
  private heroHp = 100
  private readonly heroMaxHp = 100
  private energy = 50
  private score = 0
  private punchChain = 0
  private lastPunchSide: 'left' | 'right' | null = null
  private chainTimeLeft = 0
  private combo = 0
  private maxCombo = 0
  private comboResetTimer = 0
  private perfectGuards = 0
  private defeatedCount = 0

  private waveTransitionTimer = 0

  // 招式、防御时机与双光线对波状态
  private beamDamageTicksRemaining = 0
  private beamTickTimer = 0
  private beamDamagePerTick = 26
  private beamCooldown = 0
  private discCooldown = 0
  private beamClashActive = false
  private beamClashTimer = 0
  private beamClashProgress = 0.5

  private manualLean = 0
  private manualGuard = false
  private guardStartedAt = -Infinity
  private wasGuarding = false

  private gestureLean = 0
  private gestureGuard = false
  private gestureTracking = false
  private gestureCoverage: 'none' | 'upper' | 'full' = 'none'
  private gestureMirroredX = 0.5
  private gestureHintKey = 'hintReady'
  private gestureBeamCharge = 0
  private gestureBeamHolding = false
  private gestureBeamArmSide: 'left' | 'right' = 'right'
  private gestureDiscCharge = 0
  private gestureDiscSide: 'left' | 'right' | null = null
  private gestureTypeCharge = 0

  // 镜头动效（命中顿帧 + FOV 冲击推镜 + trauma² 多频震动）
  private hitStopTimer = 0
  private shakeTrauma = 0
  private fovKick = 0
  private skillBannerKey: string | null = null
  private skillBannerTimer = 0
  private floatingIdCounter = 1
  private floatSpreadIndex = 0
  private hudSyncAccumulator = 0

  private readonly cameraAnchor = new THREE.Vector3(6.6, 9.8, 31.2)
  private readonly lookAnchor = new THREE.Vector3(-0.3, 7.2, 3.8)

  private paused = false
  private viewportAspect = 16 / 9
  private readonly resizeObserver: ResizeObserver

  constructor(container: HTMLElement, callbacks: EngineCallbacks) {
    this.container = container
    this.callbacks = callbacks

    this.scene = new THREE.Scene()
    const w = Math.max(1, container.clientWidth || window.innerWidth)
    const h = Math.max(1, container.clientHeight || window.innerHeight)
    this.viewportAspect = w / h

    this.camera = new THREE.PerspectiveCamera(46, this.viewportAspect, 0.5, 450)
    this.camera.position.copy(this.cameraAnchor)
    this.camera.lookAt(this.lookAnchor)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(w, h)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.06

    container.appendChild(this.renderer.domElement)

    this.arena = new ArenaManager(this.scene, this.renderer)
    this.hero = new HeroController(this.scene)
    this.kaiju = new KaijuController(this.scene)
    this.effects = new BattleEffects(this.scene)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.lastTimestamp = performance.now()
    this.loop(this.lastTimestamp)
  }

  private handleResize() {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth || window.innerWidth)
    const h = Math.max(1, this.container.clientHeight || window.innerHeight)
    this.viewportAspect = w / h
    this.camera.aspect = this.viewportAspect
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  public async setSceneTheme(theme: SceneTheme, previewWaveIndex?: number) {
    this.preferredTheme = theme
    const concrete = this.resolveThemeForWave(previewWaveIndex ?? this.waveIndex)
    await this.arena.setTheme(concrete)
    this.emitHud()
  }

  private resolveThemeForWave(waveIdx: number): ConcreteSceneTheme {
    if (this.preferredTheme !== 'auto') return this.preferredTheme
    return MONSTER_WAVES[waveIdx]?.defaultTheme ?? 'seaside'
  }

  public preloadBaseAssets(): Promise<void> {
    this.baseAssets ??= this.loadBaseAssets().catch((error) => {
      this.baseAssets = null
      throw error
    })
    return this.baseAssets
  }

  private async loadBaseAssets() {
    this.loadingProgress = 15
    this.emitHud()
    await Promise.all([
      this.hero.load(this.loader, this.heroProfile),
      this.arena.setTheme(this.resolveThemeForWave(this.waveIndex)),
      this.kaiju.spawn(this.loader, MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!),
    ])
    if (this.disposed) return
    let preview: HeroProfile
    do {
      preview = this.heroProfile
      await this.hero.load(this.loader, preview)
      if (this.disposed) return
    } while (preview !== this.heroProfile)
    this.kaiju.encounter.enter('idle')
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.85)
    this.loadingProgress = 100
    this.assetsReady = true
    this.emitHud()
  }

  /** 菜单实时切换光之战士，播放登场战姿与光粒脉冲 */
  public async setHero(heroId: HeroId): Promise<void> {
    const profile = HERO_PROFILES[heroId]
    if (profile.id === this.heroProfile.id) return
    this.heroProfile = profile
    this.heroFormIndex = 0
    this.applyHeroForm()
    this.emitHud()
    if (this.phase !== 'menu' || !this.assetsReady) return
    this.loadingProgress = 40
    this.emitHud()
    await this.hero.load(this.loader, profile)
    if (this.disposed || profile !== this.heroProfile || this.phase !== 'menu') return
    this.hero.resetPose()
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.85)
    const burstPos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.2, -0.8))
    this.effects.spawnBurst(burstPos, profile.accentColor, 18, 18, 1.1)
    this.effects.spawnImpactRing(burstPos, profile.accentColor, 5.5)
    this.loadingProgress = 100
    this.emitHud()
  }

  /** 菜单选关时同步预览对应怪兽与默认场景 */
  public async previewWave(waveIdx: number) {
    const clamped = THREE.MathUtils.clamp(waveIdx, 0, MONSTER_WAVES.length - 1)
    this.waveIndex = clamped
    if (this.phase !== 'menu' || !this.assetsReady) return
    const spec = MONSTER_WAVES[clamped]!
    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(clamped)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed || this.phase !== 'menu') return
    this.kaiju.encounter.enter('idle')
    this.emitHud()
  }

  /** 菜单内直接预览形态切换（迪迦 / 戴拿） */
  public previewNextForm() {
    if (!this.heroProfile.forms) return
    this.heroFormIndex = (this.heroFormIndex + 1) % this.heroProfile.forms.length
    const form = this.activeForm!
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.7)
    const pos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, -0.6))
    this.effects.spawnBurst(pos, form.accentColor, 20, 20, 1.2)
    this.effects.spawnImpactRing(pos, form.accentColor, 6.2)
    this.audio.playTransform()
    this.emitHud()
  }

  private get activeForm(): HeroFormSpec | null {
    return this.heroProfile.forms?.[this.heroFormIndex] ?? null
  }

  private get totalDamageMul(): number {
    return this.heroProfile.baseDamageMul * (this.activeForm?.damageMul ?? 1)
  }

  private get totalEnergyMul(): number {
    return this.heroProfile.baseEnergyGainMul * (this.activeForm?.energyGainMul ?? 1)
  }

  private gainEnergy(baseAmount: number) {
    this.energy = Math.min(100, this.energy + baseAmount * this.totalEnergyMul)
  }

  private applyHeroForm() {
    const form = this.activeForm
    this.hero.setForm(form)
    this.effects.setHeroTheme(
      form
        ? {
            ...this.heroProfile,
            accentColor: form.accentColor,
            beamColor: form.beamColor,
            beamSuperColor: form.beamSuperColor,
            discColor: form.discColor,
            burstColor: form.burstColor,
          }
        : this.heroProfile,
    )
  }

  private switchHeroForm() {
    if (!this.heroProfile.forms) return
    this.heroFormIndex = (this.heroFormIndex + 1) % this.heroProfile.forms.length
    const form = this.activeForm!
    this.applyHeroForm()

    const pos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, -0.8))
    this.effects.spawnBurst(pos, form.accentColor, 28, 26, 1.45)
    this.effects.spawnHitFlash(pos, form.accentColor, 1.6)
    this.effects.spawnImpactRing(pos, form.accentColor, 7.5)

    // 变身能量爆发可震碎身前逼近的怪兽火球
    this.deflectNearbyFireballs(6.5)

    this.audio.playTransform()
    this.addTrauma(0.32)
    this.fovKick = -3.2
    this.showBanner(`bannerForm${form.bannerKey}`, 1.35)
    this.emitHud()
  }

  public triggerManualTypeSwitch() {
    if (this.phase === 'menu') {
      this.previewNextForm()
      return
    }
    if (this.phase !== 'fighting') return
    this.switchHeroForm()
  }

  public setControlMode(mode: ControlMode) {
    this.controlMode = mode
    this.emitHud()
  }

  public async startGame(
    mode: ControlMode,
    startWaveIndex = 0,
    theme: SceneTheme = this.preferredTheme,
  ): Promise<void> {
    this.controlMode = mode
    this.preferredTheme = theme
    this.audio.unlock()
    this.resetTracking()
    this.effects.clearAllDynamic()

    this.phase = 'loading'
    this.loadingProgress = this.assetsReady ? 65 : 10
    this.emitHud()

    if (!this.assetsReady) {
      await this.preloadBaseAssets()
    }

    if (this.disposed) return
    await this.hero.load(this.loader, this.heroProfile)
    if (this.disposed) return
    this.waveIndex = THREE.MathUtils.clamp(startWaveIndex, 0, MONSTER_WAVES.length - 1)
    this.heroHp = this.heroMaxHp
    this.energy = 50
    this.score = 0
    this.combo = 0
    this.maxCombo = 0
    this.perfectGuards = 0
    this.defeatedCount = 0
    this.manualLean = 0
    this.manualGuard = false
    this.wasGuarding = false
    this.guardStartedAt = -Infinity
    this.gestureLean = 0
    this.gestureGuard = false
    this.gestureBeamCharge = 0
    this.gestureBeamHolding = false
    this.gestureDiscCharge = 0
    this.beamCooldown = 0
    this.discCooldown = 0
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.beamClashProgress = 0.5
    this.applyHeroForm()
    this.hero.resetPose()
    this.audio.setDangerAlarm(false)
    this.audio.playTransform()

    await this.loadWave(this.waveIndex)
  }

  private async loadWave(index: number): Promise<void> {
    const spec = MONSTER_WAVES[index]!
    this.feetTracked = false
    this.jump.reset()
    this.punchChain = 0
    this.chainTimeLeft = 0
    this.waveIndex = index
    this.monsterMaxHp = spec.maxHp
    this.monsterHp = spec.maxHp
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.effects.clearAllDynamic()

    this.phase = 'loading'
    this.loadingProgress = 75
    this.emitHud()

    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(index)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed) return
    this.loadingProgress = 100
    this.phase = 'intro'
    this.waveTransitionTimer = 1.2
    this.addTrauma(0.38)
    this.showBanner('bannerWaveStart', 1.35)
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.audio.setDangerAlarm(false)
    this.effects.clearAllDynamic()
    this.hero.resetPose()
    this.hero.triggerAction('pose-intro', 0.8)
    this.kaiju.encounter.enter('idle')
    this.emitHud()
  }

  public setPaused(paused: boolean) {
    this.paused = paused
    this.audio.setDangerAlarm(
      !paused && this.heroHp > 0 && this.heroHp <= this.heroMaxHp * 0.3 && this.phase === 'fighting',
    )
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
    if (muted) this.audio.setDangerAlarm(false)
  }

  public feedPoseLandmarks(
    landmarks: PoseLandmark[] | null,
    worldLandmarks: PoseLandmark[] | null,
    now: number,
    width: number,
    height: number,
    laneCenter?: number,
  ) {
    if (this.controlMode !== 'camera') return
    const snap = this.gesture.update(
      landmarks,
      now,
      width,
      height,
      worldLandmarks,
      !!this.heroProfile.forms,
      laneCenter,
    )
    this.gestureTracking = snap.tracking
    const fullBody = snap.coverage === 'full' && canTrackFeet(landmarks)
    const physicalKick = fullBody && this.feetTracked ? snap.kick : null
    this.feetTracked = fullBody
    this.gestureCoverage = fullBody ? 'full' : snap.tracking ? 'upper' : 'none'
    this.gestureMirroredX = snap.mirroredCenterX
    this.gestureLean = snap.lean
    this.gestureGuard = snap.guard
    if (snap.guardJustStarted) {
      this.guardStartedAt = this.elapsedTime
    }
    this.gestureBeamCharge = snap.beamCharge
    this.gestureBeamHolding = snap.beamHolding
    this.gestureBeamArmSide = snap.beamArmSide
    this.gestureDiscCharge = snap.discCharge
    this.gestureDiscSide = snap.discSide
    this.gestureTypeCharge = snap.typeCharge
    this.gestureHintKey =
      !physicalKick && snap.hintKey === 'hintKick' ? 'hintReady' : snap.hintKey
    if (snap.livePose && !fullBody) snap.livePose.coverage = 'upper'

    this.hero.setLiveBodyPose(snap.livePose, now)

    if (this.phase !== 'fighting') return

    // 对波期间：挥拳或脚踢都会直接给光束注入推进爆发力
    if (this.beamClashActive) {
      if (snap.punch || physicalKick) {
        this.boostBeamClash(0.14)
      }
      return
    }

    const jumped = this.jump.update(
      !fullBody && snap.tracking ? landmarks : null,
      now,
      width / height,
    )
    if (jumped) {
      this.executeKick('right', true)
    } else if (snap.typeTrigger) {
      this.switchHeroForm()
    } else if (snap.beamTrigger) {
      this.executeBeam()
    } else if (snap.discTrigger) {
      this.executeDisc(snap.discTrigger)
    } else if (physicalKick) {
      this.executeKick(physicalKick)
    } else if (snap.punch) {
      this.executePunch(snap.punch)
    }
  }

  public resetTracking() {
    this.feetTracked = false
    this.jump.reset()
    this.gesture.reset()
  }

  public recenter() {
    this.gesture.recenter()
    this.jump.reset()
  }

  public setManualLean(dir: -1 | 0 | 1) {
    this.manualLean = dir
  }

  public setManualGuard(active: boolean) {
    if (active && !this.manualGuard) {
      this.guardStartedAt = this.elapsedTime
    }
    this.manualGuard = active
  }

  public triggerManualPunch(side: 'left' | 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.13)
      return
    }
    this.executePunch(side)
  }

  public triggerManualKick(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.15)
      return
    }
    this.executeKick(side)
  }

  public triggerManualDisc(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.15)
      return
    }
    this.executeDisc(side)
  }

  public triggerManualBeam() {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.16)
      return
    }
    this.executeBeam()
  }

  /** 挥拳/飞踢/光轮正面弹反击碎逼近的怪兽火球，化作金色光弹反轰怪兽 */
  private deflectNearbyFireballs(reachZ = 5.6): boolean {
    let deflected = false
    const kaijuCenter = this.kaiju.getTargetCenter()
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      const proj = this.effects.projectiles[i]!
      if (proj.fromHero || proj.hitTriggered || proj.kind !== 'kaiju-fireball') continue
      const dz = this.hero.baseZ - proj.pos.z
      const dx = Math.abs(this.hero.currentX - proj.pos.x)
      if (dz >= -1.2 && dz <= reachZ && dx <= 4.4) {
        const hitPos = proj.pos.clone()
        this.effects.removeProjectileAt(i)
        this.effects.spawnBurst(hitPos, 0xfacc15, 22, 26, 1.25)
        this.effects.spawnImpactRing(hitPos, 0xfef08a, 6.2)
        this.effects.spawnHitFlash(hitPos, 0xffffff, 1.3)
        // 反弹一道金色光冲击反轰怪兽
        this.effects.spawnPunchWave(
          hitPos,
          kaijuCenter,
          Math.round(38 * this.totalDamageMul),
          'right',
          true,
        )
        this.audio.playDeflect()
        this.gainEnergy(18)
        this.score += 320
        this.addHitStop(0.055)
        this.addTrauma(0.32)
        this.spawnFloatingAtWorld(
          hitPos.clone().add(new THREE.Vector3(0, 2.2, 0)),
          'DEFLECT!',
          '#fde047',
          1.25,
          'guard',
        )
        deflected = true
      }
    }
    return deflected
  }

  private executePunch(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive()) return
    this.punchChain = this.chainTimeLeft > 0 && this.lastPunchSide !== side ? this.punchChain + 1 : 1
    const finisher = this.punchChain >= 3
    if (finisher) this.punchChain = 3
    this.lastPunchSide = side
    this.chainTimeLeft = finisher ? 0 : 1.5

    this.hero.triggerAction(
      finisher ? 'punch-heavy' : side === 'left' ? 'punch-left' : 'punch-right',
      finisher ? 0.38 : 0.28,
    )
    if (finisher) this.fovKick = -2.6

    // 先判定是否挥拳击碎飞来的怪兽火球
    if (this.deflectNearbyFireballs(5.8) && !finisher) {
      if (finisher) this.punchChain = 0
      this.emitHud()
      return
    }

    const origin = this.hero.getFistOrigin(side)
    const target = this.kaiju.getTargetCenter()
    const damage = Math.round((finisher ? 62 : 29) * this.totalDamageMul)
    this.effects.spawnPunchWave(origin, target, damage, side, finisher)
    this.effects.spawnBurst(origin, this.heroProfile.burstColor, 7, 14, 0.65)
    this.audio.playSwing(side, false)
    if (finisher) this.punchChain = 0
    this.emitHud()
  }

  private executeKick(side: 'left' | 'right', jumping = false) {
    if (this.effects.isHeroBeamActive()) return
    const action = jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right'
    this.hero.triggerAction(action, jumping ? 0.48 : 0.38)
    this.fovKick = jumping ? -3.5 : -2.4
    this.deflectNearbyFireballs(6.2)

    const origin = this.hero.getFootOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnKickWave(
      origin,
      target,
      Math.round((jumping ? 68 : 48) * this.totalDamageMul),
    )
    this.effects.spawnBurst(origin, 0xf97316, 12, 18, 0.85)
    this.audio.playSwing(side, true)
    this.showBanner(jumping ? 'bannerJumpKick' : 'bannerKick', 0.85)
  }

  private executeDisc(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive() || this.discCooldown > 0) return
    const cdMul = this.activeForm?.discCooldownMul ?? 1
    this.discCooldown = DISC_MAX_COOLDOWN * cdMul
    this.hero.setDiscCharge(0, side)
    this.hero.triggerAction('disc', 0.42)
    this.deflectNearbyFireballs(6.8)

    const origin = this.hero.getDiscOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnUltraDisc(origin, target, Math.round(78 * this.totalDamageMul))
    this.audio.playDisc()
    this.showBanner(`bannerDisc${this.heroProfile.bannerKey}`, 1.0)
    this.emitHud()
  }

  private executeBeam() {
    if (this.effects.isHeroBeamActive() || this.beamCooldown > 0) return
    if (this.energy < 35) {
      this.spawnFloatingAtWorld(
        this.hero.root.position.clone().add(new THREE.Vector3(0, 14, 0)),
        'ENERGY LOW!',
        '#facc15',
        0.95,
      )
      return
    }
    const isSuper = this.energy >= 100
    this.energy = Math.max(0, this.energy - (isSuper ? 100 : 35))
    this.beamCooldown = BEAM_MAX_COOLDOWN

    // 检查怪兽是否正在蓄力或发射暗黑破坏光线 -> 直接触发特摄宿命双光线对波！
    const fight = this.kaiju.encounter
    const spec = MONSTER_WAVES[this.waveIndex]!
    if (
      fight.attack === 'dark-beam' &&
      ((fight.state === 'windup' && fight.time >= 0.25) || fight.state === 'attack')
    ) {
      this.startBeamClash(isSuper, spec.accentColor)
      return
    }

    const dur = isSuper ? 1.75 : 1.25
    this.hero.triggerAction('beam', dur)
    this.effects.startHeroBeam(isSuper, dur)
    this.audio.playBeam(isSuper)
    this.addTrauma(isSuper ? 0.65 : 0.42)
    this.fovKick = isSuper ? -4.5 : -3.0
    this.beamDamageTicksRemaining = isSuper ? 5 : 4
    this.beamDamagePerTick = Math.round((isSuper ? 48 : 32) * this.totalDamageMul)
    this.beamTickTimer = 0.16
    this.showBanner(
      isSuper
        ? `bannerSuperBeam${this.heroProfile.bannerKey}`
        : `bannerBeam${this.heroProfile.bannerKey}`,
      dur,
    )
    this.emitHud()
  }

  /** 启动双光线对波角力名场面 */
  private startBeamClash(isSuper: boolean, kaijuColor: number) {
    this.beamClashActive = true
    this.beamClashTimer = 1.65
    this.beamClashProgress = isSuper ? 0.64 : 0.52
    this.beamDamageTicksRemaining = 0

    this.kaiju.encounter.enter('attack')
    this.hero.triggerAction('beam', 1.8)
    this.effects.startHeroBeam(isSuper, 1.8)
    this.effects.startKaijuBeam(kaijuColor, 1.8)
    this.effects.setBeamClash(true, this.beamClashProgress)

    this.audio.playBeam(isSuper)
    this.audio.playBeamClash()
    this.addTrauma(0.6)
    this.fovKick = -4.2
    this.showBanner('bannerBeamClash', 1.65)
    this.emitHud()
  }

  private boostBeamClash(delta: number) {
    if (!this.beamClashActive) return
    this.beamClashProgress = Math.min(1, this.beamClashProgress + delta)
    this.addTrauma(0.18)
    this.audio.playPunch(false)
    this.emitHud()
  }

  private finishBeamClash(won: boolean) {
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.effects.setBeamClash(false, 0.5)
    this.effects.stopHeroBeam()
    this.effects.stopKaijuBeam()

    if (won) {
      const center = this.kaiju.getTargetCenter()
      this.effects.spawnBurst(center, 0xfef08a, 36, 34, 1.6)
      this.effects.spawnImpactRing(center, 0xfacc15, 12)
      this.effects.spawnHitFlash(center, 0xffffff, 2.2)
      this.audio.playHeavyImpact()
      this.audio.playExplosion()
      this.kaiju.encounter.enter('staggered')
      this.gainEnergy(25)
      this.score += 650
      this.showBanner('bannerClashWin', 1.25)
      this.applyDamageToMonster(
        Math.round(148 * this.totalDamageMul),
        '#fef08a',
        true,
        'heavy',
      )
    } else {
      const spec = MONSTER_WAVES[this.waveIndex]!
      this.kaiju.encounter.enter('recovering')
      this.applyAttackOnHero(Math.round(spec.attackDamage * 0.65), 'dark-beam', this.hero.currentX)
    }
    this.emitHud()
  }

  private showBanner(key: string, duration: number) {
    this.skillBannerKey = key
    this.skillBannerTimer = duration
  }

  private addTrauma(amount: number) {
    this.shakeTrauma = Math.min(1.1, this.shakeTrauma + amount)
  }

  private addHitStop(seconds: number) {
    this.hitStopTimer = Math.max(this.hitStopTimer, seconds)
  }

  private applyDamageToMonster(
    amount: number,
    color: string,
    isCritical = false,
    impact: Impact = 'light',
    punchSide?: 'left' | 'right',
  ) {
    if (this.phase !== 'fighting' || this.monsterHp <= 0) return

    const id = MONSTER_WAVES[this.waveIndex]!.id
    amount = this.kaiju.encounter.receiveHit(
      amount,
      impact,
      id === 'zetton' || id === 'gomora-mecha',
    )
    this.monsterHp = Math.max(0, this.monsterHp - amount)
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.comboResetTimer = 3.4
    this.score += amount * (10 + Math.min(25, this.combo))

    const hitPos = this.kaiju.getTargetCenter()
    if (punchSide) hitPos.x += punchSide === 'left' ? -1.4 : 1.4
    this.kaiju.triggerHitFlash(isCritical ? 1 : 0.72, punchSide)
    this.effects.spawnBurst(
      hitPos,
      isCritical ? 0xfacc15 : this.heroProfile.beamColor,
      isCritical ? 24 : 14,
      isCritical ? 28 : 20,
      isCritical ? 1.25 : 0.92,
    )

    if (impact === 'heavy') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime)
      this.addHitStop(0.08)
      this.addTrauma(0.42)
      this.fovKick = -2.8
      this.effects.spawnImpactRing(hitPos, 0xfef08a, 7.2)
      this.effects.spawnHitFlash(hitPos, isCritical ? 0xfef08a : 0xffffff, 1.4)
    } else if (impact === 'light') {
      this.addHitStop(0.048)
      this.addTrauma(0.24)
      this.fovKick = -1.4
      this.effects.spawnImpactRing(hitPos, this.heroProfile.burstColor, 4.6)
      this.effects.spawnHitFlash(hitPos, 0xffffff, 1.0)
    } else {
      this.addTrauma(0.12)
      this.effects.spawnHitFlash(hitPos, this.heroProfile.beamColor, 0.95)
    }

    this.spawnFloatingAtWorld(
      hitPos.clone().add(new THREE.Vector3(0, 1.8, 0)),
      `-${amount}${isCritical ? '!' : ''}`,
      color,
      isCritical ? 1.32 : 1.0,
      isCritical ? 'crit' : 'normal',
    )

    if (this.monsterHp <= 0) {
      this.onMonsterDefeated()
    }
    this.emitHud()
  }

  private onMonsterDefeated() {
    this.defeatedCount += 1
    this.score += 1500 + this.waveIndex * 650
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.effects.setBeamClash(false, 0.5)
    this.kaiju.encounter.enter('dying')
    this.audio.playExplosion()
    this.addHitStop(0.12)
    this.addTrauma(0.92)
    this.fovKick = -4.5

    const center = this.kaiju.getTargetCenter()
    this.effects.spawnImpactRing(center, 0xffd28a, 13)
    this.effects.spawnBurst(center, 0xff6b2b, 38, 34, 1.65)
    this.effects.spawnBurst(center.clone().add(new THREE.Vector3(0, 3, 1)), 0xfacc15, 28, 28, 1.4)
    this.effects.spawnHitFlash(center, 0xffffff, 2.4)

    if (this.waveIndex + 1 >= MONSTER_WAVES.length) {
      this.phase = 'victory'
      this.audio.setDangerAlarm(false)
      this.hero.triggerAction('victory', 5)
      this.audio.playVictory()
      this.showBanner('bannerVictory', 3.5)
    } else {
      this.phase = 'wave-clear'
      this.waveTransitionTimer = 2.5
      this.showBanner('bannerWaveClear', 2.1)
    }
    this.emitHud()
  }

  private applyAttackOnHero(damage: number, attack: MonsterAttackKind, attackX: number) {
    if (this.phase !== 'fighting') return

    // 英雄正在发射必杀光线：若怪兽喷射暗黑光线则直接碰撞进入宿命对波！否则光之气场抵消伤害
    if (this.effects.isHeroBeamActive()) {
      if (attack === 'dark-beam' && !this.beamClashActive) {
        const spec = MONSTER_WAVES[this.waveIndex]!
        this.startBeamClash(false, spec.accentColor)
        return
      }
      this.effects.spawnBurst(
        new THREE.Vector3(this.hero.currentX, 9.5, this.hero.baseZ - 2.2),
        0x7dd3fc,
        14,
        18,
      )
      return
    }

    if (attack === 'fireball' && Math.abs(this.hero.currentX - attackX) > 2.95) {
      this.gainEnergy(15)
      this.score += 240
      this.audio.playDodge()
      this.spawnFloatingAtWorld(
        new THREE.Vector3(this.hero.currentX, 14.2, this.hero.baseZ),
        'PERFECT DODGE!',
        '#4ade80',
        1.18,
        'dodge',
      )
      this.emitHud()
      return
    }

    const isGuarding = this.isHeroGuarding()
    if (isGuarding) {
      const isJustGuard = this.elapsedTime - this.guardStartedAt <= 0.72
      this.audio.playGuardBlock()
      this.effects.triggerShieldBlockFlash()
      this.effects.spawnBurst(
        new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 2.6),
        isJustGuard ? 0xfef08a : 0x7dd3fc,
        isJustGuard ? 22 : 12,
        22,
        1.05,
      )
      this.effects.spawnImpactRing(
        new THREE.Vector3(this.hero.currentX, 9.0, this.hero.baseZ - 2.6),
        isJustGuard ? 0xfef08a : 0x7dd3fc,
        isJustGuard ? 6.5 : 4.5,
      )
      this.addHitStop(isJustGuard ? 0.055 : 0.03)
      this.addTrauma(isJustGuard ? 0.34 : 0.2)

      if (isJustGuard) {
        if (attack === 'melee' && this.kaiju.encounter.state === 'attack') {
          this.kaiju.encounter.enter('staggered')
        }
        this.perfectGuards += 1
        this.gainEnergy(28)
        this.score += 400
        this.spawnFloatingAtWorld(
          new THREE.Vector3(this.hero.currentX, 14.6, this.hero.baseZ),
          'PERFECT GUARD!',
          '#38bdf8',
          1.24,
          'guard',
        )
        this.showBanner('bannerPerfectGuard', 0.95)
      } else {
        const chipDamage = Math.max(2, Math.round(damage * 0.2))
        this.heroHp = Math.max(1, this.heroHp - chipDamage)
        this.gainEnergy(10)
        this.score += 120
        this.spawnFloatingAtWorld(
          new THREE.Vector3(this.hero.currentX, 14.4, this.hero.baseZ),
          `GUARD -${chipDamage}`,
          '#93c5fd',
          1.0,
          'guard',
        )
      }
      this.emitHud()
      return
    }

    this.chainTimeLeft = 0
    this.punchChain = 0
    this.heroHp = Math.max(0, this.heroHp - damage)
    this.combo = 0
    this.hero.triggerAction('hit', 0.42)
    this.audio.playHeroHurt()
    this.addHitStop(0.075)
    this.addTrauma(0.56)
    this.effects.spawnBurst(
      new THREE.Vector3(this.hero.currentX, 9.5, this.hero.baseZ - 1.2),
      0xff4444,
      18,
      20,
      1.1,
    )
    this.effects.spawnImpactRing(
      new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 1.4),
      0xff8888,
      5.5,
    )
    this.effects.spawnHitFlash(
      new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 1.4),
      0xff8888,
      1.15,
    )
    this.spawnFloatingAtWorld(
      new THREE.Vector3(this.hero.currentX, 14.5, this.hero.baseZ),
      `-${damage}`,
      '#ff4d4f',
      1.25,
    )

    if (this.heroHp <= 0) {
      this.phase = 'defeat'
      this.audio.setDangerAlarm(false)
      this.showBanner('bannerDefeat', 3.0)
    } else if (this.heroHp <= this.heroMaxHp * 0.3) {
      this.audio.setDangerAlarm(true)
    }
    this.emitHud()
  }

  private isHeroGuarding(): boolean {
    return this.manualGuard || this.gestureGuard
  }

  private spawnFloatingAtWorld(
    worldPos: THREE.Vector3,
    text: string,
    color: string,
    scale = 1,
    kind: FloatingDamageEvent['kind'] = 'normal',
  ) {
    const projected = worldPos.clone().project(this.camera)
    // 扇形交替错位，彻底消除多段伤害数字重叠糊成一团的问题
    const slot = this.floatSpreadIndex++ % 5
    const offsetX = [-4.5, 4.2, -2.2, 2.8, 0][slot]!
    const offsetY = [-2.5, -1.2, -4.4, -3.4, 0][slot]!
    const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * 100 + offsetX, 12, 88)
    const y = THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * 100 + offsetY, 16, 80)
    this.callbacks.onFloatingText({
      id: this.floatingIdCounter++,
      text,
      color,
      x,
      y,
      scale,
      driftX: offsetX * 4,
      kind,
    })
  }

  private loop = (now: number) => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.loop)

    const rawDt = Math.min(0.05, Math.max(0.001, (now - this.lastTimestamp) / 1000))
    this.lastTimestamp = now
    if (this.paused) return
    this.elapsedTime += rawDt

    let dt = rawDt
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= rawDt
      dt = rawDt * 0.12
    }

    this.stepSimulation(dt, rawDt, now)
    this.renderer.render(this.scene, this.camera)
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    if (this.beamCooldown > 0) this.beamCooldown = Math.max(0, this.beamCooldown - dt)
    if (this.discCooldown > 0) this.discCooldown = Math.max(0, this.discCooldown - dt)
    if (this.skillBannerTimer > 0) {
      this.skillBannerTimer = Math.max(0, this.skillBannerTimer - dt)
      if (this.skillBannerTimer <= 0) this.skillBannerKey = null
    }
    this.chainTimeLeft = Math.max(0, this.chainTimeLeft - rawDt)
    if (this.chainTimeLeft === 0) this.punchChain = 0
    if (this.combo > 0) {
      this.comboResetTimer -= dt
      if (this.comboResetTimer <= 0) this.combo = 0
    }

    const combinedLean =
      this.manualLean !== 0
        ? this.manualLean
        : this.controlMode === 'camera'
          ? this.gestureLean
          : 0
    const guarding = this.isHeroGuarding()
    if (guarding && !this.wasGuarding) {
      this.guardStartedAt = this.elapsedTime
    }
    this.wasGuarding = guarding

    this.hero.setLean(combinedLean)
    this.hero.setGuard(guarding)
    this.hero.setBeamCharge(
      this.controlMode === 'camera' ? this.gestureBeamCharge : 0,
      this.gestureBeamArmSide,
    )
    this.hero.setDiscCharge(
      this.controlMode === 'camera' ? this.gestureDiscCharge : 0,
      this.gestureDiscSide,
    )

    const dangerTimer = this.phase === 'fighting' && this.heroHp <= this.heroMaxHp * 0.3
    this.hero.update(dt, this.elapsedTime, dangerTimer, nowMs, rawDt)
    if (this.phase !== 'fighting') this.advanceEncounter(dt, false)
    this.kaiju.update(dt, this.elapsedTime, this.hero.currentX)
    this.arena.update(
      this.elapsedTime,
      this.hero.root.position,
      this.kaiju.root.position,
      this.kaiju.root.visible,
    )

    if (this.phase === 'intro') {
      this.waveTransitionTimer -= dt
      if (this.waveTransitionTimer <= 0) {
        this.phase = 'fighting'
        this.emitHud()
      }
    } else if (this.phase === 'wave-clear') {
      this.waveTransitionTimer -= dt
      if (this.waveTransitionTimer <= 0) {
        this.heroHp = Math.min(this.heroMaxHp, this.heroHp + 35)
        if (this.heroHp > this.heroMaxHp * 0.3) {
          this.audio.setDangerAlarm(false)
        }
        void this.loadWave(this.waveIndex + 1)
      }
    } else if (this.phase === 'fighting') {
      this.stepCombat(dt)
    }

    const beamSeg = this.hero.getBeamOriginSegment()
    const kaijuTarget = this.kaiju.getTargetCenter()
    const kaijuEmit = this.kaiju.getAttackEmitOrigin()
    const heroCenter = new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ)
    const spec = MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!
    const fight = this.kaiju.encounter

    this.effects.update(
      dt,
      this.elapsedTime,
      beamSeg,
      kaijuTarget,
      kaijuEmit,
      heroCenter,
      this.camera.quaternion,
    )
    this.effects.updateShield(
      guarding,
      this.hero.currentX,
      this.hero.root.position.z,
      dt,
      this.elapsedTime,
    )
    this.effects.updateChargePreview(
      this.controlMode === 'camera' ? this.gestureBeamCharge : 0,
      beamSeg[0].clone().lerp(beamSeg[1], 0.55),
      this.controlMode === 'camera' ? this.gestureDiscCharge : 0,
      this.hero.getDiscOrigin(this.gestureDiscSide ?? 'right'),
      this.elapsedTime,
    )
    this.effects.updateTypeCharge(
      this.controlMode === 'camera' && this.heroProfile.forms ? this.gestureTypeCharge : 0,
      new THREE.Vector3(this.hero.currentX, 15.2, this.hero.root.position.z + 0.4),
      this.activeForm?.accentColor ?? 0xb388ff,
      this.elapsedTime,
    )

    const isWarning = this.phase === 'fighting' && fight.state === 'windup' && !this.beamClashActive
    const showKaijuOrb =
      isWarning && (fight.attack === 'fireball' || fight.attack === 'dark-beam')
    this.effects.updateKaijuChargeOrb(
      showKaijuOrb,
      kaijuEmit,
      isWarning ? fight.time / WINDUP_TIME : 0,
      spec.accentColor,
      this.elapsedTime,
    )
    this.effects.updateWarningRing(
      isWarning,
      fight.attack === 'fireball' ? fight.targetX : this.hero.currentX,
      this.hero.baseZ,
      isWarning ? fight.time / WINDUP_TIME : 0,
      this.elapsedTime,
    )

    this.updateCamera(rawDt)

    this.hudSyncAccumulator += dt
    if (this.hudSyncAccumulator >= 0.06) {
      this.hudSyncAccumulator = 0
      this.emitHud()
    }
  }

  private stepCombat(dt: number) {
    // 宿命双光线对波结算循环
    if (this.beamClashActive) {
      this.beamClashTimer -= dt
      const pushUp =
        this.controlMode === 'camera' && this.gestureBeamHolding ? 0.52 : 0.28
      const kaijuPush = 0.22
      this.beamClashProgress = THREE.MathUtils.clamp(
        this.beamClashProgress + (pushUp - kaijuPush) * dt,
        0.05,
        1.0,
      )
      this.effects.setBeamClash(true, this.beamClashProgress)
      this.addTrauma(0.06)

      if (this.beamClashProgress >= 0.96) {
        this.finishBeamClash(true)
      } else if (this.beamClashTimer <= 0) {
        this.finishBeamClash(this.beamClashProgress >= 0.48)
      }
      return
    }

    if (this.beamDamageTicksRemaining > 0) {
      this.beamTickTimer -= dt
      if (this.beamTickTimer <= 0) {
        this.beamTickTimer = 0.24
        this.beamDamageTicksRemaining -= 1
        this.applyDamageToMonster(this.beamDamagePerTick, '#38e8ff', true, 'beam')
      }
    }

    const kaijuCenter = this.kaiju.getTargetCenter()
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      if (this.phase !== 'fighting') return
      const proj = this.effects.projectiles[i]!
      if (proj.hitTriggered) continue

      if (proj.fromHero) {
        // 英雄抛射物若在半途撞上怪兽火球，直接将其凌空引爆！
        for (const other of this.effects.projectiles) {
          if (!other.fromHero && !other.hitTriggered && other.kind === 'kaiju-fireball') {
            if (proj.pos.distanceTo(other.pos) < 3.6) {
              other.hitTriggered = true
              this.effects.spawnBurst(other.pos, 0xfacc15, 16, 22, 1.1)
              this.effects.spawnImpactRing(other.pos, 0xfef08a, 5.2)
              this.audio.playDeflect()
              this.gainEnergy(12)
              this.score += 180
              this.spawnFloatingAtWorld(other.pos, 'SHATTER!', '#fde047', 1.1, 'guard')
            }
          }
        }

        if (proj.pos.z <= kaijuCenter.z + 3.8) {
          proj.hitTriggered = true
          if (proj.kind === 'punch-wave') {
            this.gainEnergy(proj.finisher ? 16 : 12)
            if (proj.finisher) {
              this.audio.playHeavyImpact()
              this.showBanner('bannerTriple', 0.95)
            } else {
              this.audio.playPunch(true)
            }
            this.applyDamageToMonster(
              proj.damage,
              proj.finisher ? '#fef08a' : '#fde047',
              !!proj.finisher,
              proj.finisher ? 'heavy' : 'light',
              proj.punchSide,
            )
          } else if (proj.kind === 'kick-wave') {
            this.gainEnergy(16)
            this.audio.playHeavyImpact()
            this.applyDamageToMonster(proj.damage, '#fb923c', true, 'heavy')
          } else if (proj.kind === 'ultra-disc') {
            this.gainEnergy(18)
            this.audio.playHeavyImpact()
            if (this.kaiju.encounter.state === 'windup') {
              this.kaiju.encounter.enter('staggered')
              this.showBanner('bannerInterrupt', 1.0)
            }
            this.applyDamageToMonster(proj.damage, '#67e8f9', true, 'heavy')
          }
        }
      } else {
        if (proj.pos.z >= this.hero.baseZ - 2.3) {
          proj.hitTriggered = true
          this.applyAttackOnHero(proj.damage, 'fireball', proj.pos.x)
        }
      }
    }

    if (this.phase === 'fighting') this.advanceEncounter(dt, true)
  }

  private advanceEncounter(dt: number, fighting: boolean) {
    const fight = this.kaiju.encounter
    const spec = MONSTER_WAVES[this.waveIndex]!
    const event: EncounterEvent | undefined = fight.advance(
      dt,
      fighting,
      this.monsterHp / this.monsterMaxHp,
      this.hero.currentX,
      spec,
    )
    if (event === 'warn') {
      this.audio.playWarning()
      this.emitHud()
    } else if (event === 'land' || event === 'roar' || event === 'collapse') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime)
      this.addTrauma(event === 'roar' ? 0.34 : 0.45)
      if (event === 'roar') this.audio.playRoar()
    } else if (event === 'strike') {
      if (fight.attack === 'fireball') {
        this.effects.spawnKaijuFireball(
          this.kaiju.getAttackEmitOrigin(),
          new THREE.Vector3(fight.targetX, 9.2, this.hero.baseZ),
          spec.accentColor,
          spec.attackDamage,
        )
      } else {
        if (fight.attack === 'dark-beam') this.effects.startKaijuBeam(spec.accentColor)
        this.applyAttackOnHero(
          spec.attackDamage + (fight.attack === 'dark-beam' ? 4 : 0),
          fight.attack,
          fight.targetX,
        )
      }
    }
  }

  private updateCamera(dt: number) {
    const wideFactor = THREE.MathUtils.clamp((this.viewportAspect - 0.68) / 0.72, 0, 1)
    const targetCam = new THREE.Vector3()
    const targetLook = new THREE.Vector3()

    if (this.phase === 'menu') {
      // 菜单史诗 3/4 越肩展示机位：英雄从头冠到战靴 100% 完整居中偏左立于留白区，右前方远眺讨伐怪兽与海岸山川全景
      const sway = Math.sin(this.elapsedTime * 0.55) * 0.55
      const menuOffsetX = THREE.MathUtils.lerp(2.2, 6.6, wideFactor)
      targetCam.set(menuOffsetX + sway, 9.8, 31.2)
      targetLook.set(-0.3, 7.2, 3.8)
    } else if (this.phase === 'victory') {
      targetCam.set(3.2, 9.2, 26.5)
      targetLook.copy(this.hero.root.position).add(new THREE.Vector3(0, 7, 0))
    } else if (this.beamClashActive) {
      // 宿命双光线对波：侧面戏剧性广角特写，清晰展现双方光束拉锯与交汇爆点
      const sideX = THREE.MathUtils.lerp(6.5, 13.5, wideFactor)
      targetCam.set(sideX, 10.2, 12.2)
      targetLook.set(0, 9.2, 5.2)
    } else if (this.effects.isHeroBeamActive()) {
      const sideSign = this.gestureBeamArmSide === 'left' ? -1 : 1
      const beamOffsetX = sideSign * THREE.MathUtils.lerp(3.2, 7.6, wideFactor)
      targetCam.set(this.hero.currentX * 0.45 + beamOffsetX, 10.8, 21.8)
      targetLook.set(this.kaiju.currentX * 0.45, 9.4, 2.2)
    } else {
      // 近身特摄越肩机位：根据屏幕宽高比自适应收拢偏移，窄屏/分屏绝不裁切英雄身体
      const shoulderX = THREE.MathUtils.lerp(1.1, 3.6, wideFactor)
      const camZ = THREE.MathUtils.lerp(27.8, 25.4, wideFactor)
      targetCam.set(this.hero.currentX * 0.42 + shoulderX, 12.2, camZ)
      targetLook.set(this.hero.currentX * 0.35 + shoulderX * 0.16, 8.6, -2.5)
    }

    const camRate = this.phase === 'menu' ? 4.5 : 7.2
    this.cameraAnchor.lerp(targetCam, 1 - Math.exp(-dt * camRate))
    this.lookAnchor.lerp(targetLook, 1 - Math.exp(-dt * (camRate + 1.5)))
    this.camera.position.copy(this.cameraAnchor)

    // 自适应窄屏视野补偿 + 打击推镜回弹
    this.fovKick += (0 - this.fovKick) * (1 - Math.exp(-dt * 10))
    const narrowCompensation = Math.max(0, (1.18 - this.viewportAspect) * 16)
    const desiredFov = THREE.MathUtils.clamp(46 + narrowCompensation + this.fovKick, 38, 66)
    if (Math.abs(this.camera.fov - desiredFov) > 0.02) {
      this.camera.fov = desiredFov
      this.camera.updateProjectionMatrix()
    }

    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.75)
    const shakeAmount = this.shakeTrauma * this.shakeTrauma * 1.35
    if (shakeAmount > 0.001) {
      const t = this.elapsedTime
      this.camera.position.x +=
        (Math.sin(t * 47.3) * 0.62 + Math.sin(t * 31.7) * 0.38) * shakeAmount
      this.camera.position.y +=
        (Math.sin(t * 39.1) * 0.62 + Math.sin(t * 27.3) * 0.38) * shakeAmount
      this.camera.position.z += Math.sin(t * 23.9) * 0.28 * shakeAmount
    }

    this.camera.lookAt(this.lookAnchor)
    if (shakeAmount > 0.001) {
      this.camera.rotation.z += Math.sin(this.elapsedTime * 35.7) * 0.032 * shakeAmount
    }
  }

  public getHudSnapshot(): BattleHudState {
    const spec = MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!
    const fight = this.kaiju.encounter
    let warningTextKey: string | null = null
    if (this.phase === 'fighting' && fight.state === 'windup' && !this.beamClashActive) {
      warningTextKey =
        fight.attack === 'fireball'
          ? 'warningFireball'
          : fight.attack === 'dark-beam'
            ? 'warningDarkBeam'
            : 'warningMelee'
    }

    let chargeKind: 'beam' | 'disc' | 'guard' | 'type' | null = null
    let chargeProgress = 0
    if (this.isHeroGuarding()) {
      chargeKind = 'guard'
      chargeProgress = 1
    } else if (this.gestureBeamCharge > 0.05) {
      chargeKind = 'beam'
      chargeProgress = this.gestureBeamCharge
    } else if (this.gestureDiscCharge > 0.05) {
      chargeKind = 'disc'
      chargeProgress = this.gestureDiscCharge
    } else if (this.gestureTypeCharge > 0.05) {
      chargeKind = 'type'
      chargeProgress = this.gestureTypeCharge
    }

    const discCdMax = DISC_MAX_COOLDOWN * (this.activeForm?.discCooldownMul ?? 1)

    return {
      phase: this.phase,
      controlMode: this.controlMode,
      loadingProgress: this.loadingProgress,
      heroId: this.heroProfile.id,
      heroForm: this.activeForm?.id ?? 'base',
      hasForms: !!this.heroProfile.forms,
      waveIndex: this.waveIndex,
      totalWaves: MONSTER_WAVES.length,
      activeTheme: this.arena.getTheme(),
      monsterId: spec.id,
      monsterHp: Math.round(this.monsterHp),
      monsterMaxHp: this.monsterMaxHp,
      heroHp: Math.round(this.heroHp),
      heroMaxHp: this.heroMaxHp,
      energy: Math.round(this.energy),
      score: Math.round(this.score),
      punchChain: this.punchChain,
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfectGuards: this.perfectGuards,
      defeatedCount: this.defeatedCount,
      warningTextKey,
      warningUrgency: warningTextKey ? Math.min(1, fight.time / WINDUP_TIME) : 0,
      monsterState: fight.state,
      chargeKind,
      chargeProgress,
      discCooldownRatio: THREE.MathUtils.clamp(this.discCooldown / discCdMax, 0, 1),
      beamCooldownRatio: THREE.MathUtils.clamp(this.beamCooldown / BEAM_MAX_COOLDOWN, 0, 1),
      beamClashActive: this.beamClashActive,
      beamClashProgress: this.beamClashProgress,
      activeSkillBannerKey: this.skillBannerKey,
      tracking: this.gestureTracking,
      bodyCoverage: this.gestureCoverage,
      mirroredCenterX: this.gestureMirroredX,
      poseHintKey: this.gestureHintKey,
      timerDanger: this.phase === 'fighting' && this.heroHp <= this.heroMaxHp * 0.3,
    }
  }

  private emitHud() {
    this.callbacks.onHudUpdate(this.getHudSnapshot())
  }

  public dispose() {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    this.resizeObserver.disconnect()
    this.audio.dispose()
    this.effects.dispose()
    this.kaiju.clearCurrentModel()
    this.arena.dispose()
    this.hero.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
