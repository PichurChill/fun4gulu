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

/**
 * 奥特曼 3D 全身体感战斗主引擎（迪迦 / 赛罗双英雄）
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

  // 游戏状态机
  private phase: GamePhase = 'menu'
  private heroProfile: HeroProfile = HERO_PROFILES.tiga
  /** 迪迦形态索引（复合 → 强力 → 空中 循环；无形态英雄恒 0） */
  private heroFormIndex = 0
  private controlMode: ControlMode = 'camera'
  private preferredTheme: SceneTheme = 'auto'
  private loadingProgress = 0
  private waveIndex = 0
  private monsterHp = 320
  private monsterMaxHp = 320
  private heroHp = 100
  private readonly heroMaxHp = 100
  private energy = 45
  private score = 0
  private punchChain = 0
  private lastPunchSide: 'left' | 'right' | null = null
  private chainTimeLeft = 0
  private combo = 0
  private maxCombo = 0
  private comboResetTimer = 0
  private perfectGuards = 0
  private defeatedCount = 0

  // 怪兽攻击节奏控制
  private waveTransitionTimer = 0

  // 英雄招式与动捕状态
  private beamDamageTicksRemaining = 0
  private beamTickTimer = 0
  private beamDamagePerTick = 25
  private beamCooldown = 0
  private discCooldown = 0
  private manualLean = 0
  private manualGuard = false
  private gestureLean = 0
  private gestureGuard = false
  private gestureTracking = false
  private gestureCoverage: 'none' | 'upper' | 'full' = 'none'
  private gestureHintKey = 'hintReady'
  private gestureBeamCharge = 0
  private gestureBeamArmSide: 'left' | 'right' = 'right'
  private gestureDiscCharge = 0
  private gestureDiscSide: 'left' | 'right' | null = null
  private gestureTypeCharge = 0

  // 镜头与提示动效（打击感：命中顿帧 + trauma² 多频镜头震动）
  private hitStopTimer = 0
  private shakeTrauma = 0
  private skillBannerKey: string | null = null
  private skillBannerTimer = 0
  private floatingIdCounter = 1
  private hudSyncAccumulator = 0
  // 相机基础机位与视线锚点：水平偏置经过补偿，让英雄在画面中居中而非偏左
  private readonly baseCamPos = new THREE.Vector3(2.4, 13.8, 35.6)
  private readonly camLookAt = new THREE.Vector3(-1.9, 8.6, -5)
  private readonly cameraAnchor = this.baseCamPos.clone()

  private paused = false
  private readonly resizeObserver: ResizeObserver

  constructor(container: HTMLElement, callbacks: EngineCallbacks) {
    this.container = container
    this.callbacks = callbacks

    this.scene = new THREE.Scene()
    const w = Math.max(1, container.clientWidth || window.innerWidth)
    const h = Math.max(1, container.clientHeight || window.innerHeight)

    this.camera = new THREE.PerspectiveCamera(46, w / h, 0.5, 450)
    this.camera.position.copy(this.baseCamPos)
    this.camera.lookAt(this.camLookAt)

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
    this.renderer.toneMappingExposure = 1.08

    container.appendChild(this.renderer.domElement)

    this.arena = new ArenaManager(this.scene)
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
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  /** 实时切换战场主题（菜单里点选即可立刻预览 3D 场景变化） */
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

  /** 菜单预览和快速开局共用同一次资源加载。 */
  public preloadBaseAssets(): Promise<void> {
    this.baseAssets ??= this.loadBaseAssets().catch(error => {
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
      this.kaiju.spawn(this.loader, MONSTER_WAVES[0]!),
    ])
    if (this.disposed) return
    let preview: HeroProfile
    do {
      preview = this.heroProfile
      await this.hero.load(this.loader, preview)
      if (this.disposed) return
    } while (preview !== this.heroProfile)
    this.kaiju.encounter.enter('idle')
    this.effects.setHeroTheme(this.heroProfile)
    this.loadingProgress = 100
    this.assetsReady = true
    this.emitHud()
  }

  /** 菜单里实时切换光之战士（迪迦 / 赛罗），3D 舞台立即换人预览 */
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
    this.loadingProgress = 100
    this.emitHud()
  }

  // ---- 迪迦形态系统（复合 → 强力 → 空中 循环切换） ----

  private get activeForm(): HeroFormSpec | null {
    return this.heroProfile.forms?.[this.heroFormIndex] ?? null
  }

  /** 当前形态的伤害倍率（无形态英雄为 1） */
  private get formDamageMul(): number {
    return this.activeForm?.damageMul ?? 1
  }

  /** 应用当前形态：模型染色 + 移动速度 + 特效主题色 */
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

  /** 切换到下一个形态并播放变身反馈（体感手势 / 键盘 T / 触屏按钮共用入口） */
  private switchHeroForm() {
    if (!this.heroProfile.forms) return
    this.heroFormIndex = (this.heroFormIndex + 1) % this.heroProfile.forms.length
    const form = this.activeForm!
    this.applyHeroForm()

    const pos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, 0))
    this.effects.spawnBurst(pos, form.accentColor, 30, 26, 1.6)
    this.effects.spawnHitFlash(pos, form.accentColor, 2.2)
    this.effects.spawnImpactRing(pos, form.accentColor, 9)
    this.audio.playTransform()
    this.addTrauma(0.35)
    this.showBanner(`bannerForm${form.bannerKey}`, 1.4)
    this.emitHud()
  }

  public triggerManualTypeSwitch() {
    if (this.phase !== 'fighting') return
    this.switchHeroForm()
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
    this.gestureLean = 0
    this.gestureGuard = false
    this.gestureBeamCharge = 0
    this.gestureDiscCharge = 0
    this.beamCooldown = 0
    this.discCooldown = 0
    this.heroFormIndex = 0
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
    this.effects.clearAllDynamic()

    this.phase = 'loading'
    this.loadingProgress = 75
    this.emitHud()

    await Promise.all([this.arena.setTheme(this.resolveThemeForWave(index)), this.kaiju.spawn(this.loader, spec)])
    if (this.disposed) return
    this.loadingProgress = 100
    this.phase = 'intro'
    this.waveTransitionTimer = 1.25
    this.addTrauma(0.4)
    this.showBanner('bannerWaveStart', 1.4)
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.audio.setDangerAlarm(false)
    this.effects.clearAllDynamic()
    this.hero.resetPose()
    this.kaiju.encounter.enter('idle')
    this.emitHud()
  }

  public setPaused(paused: boolean) {
    this.paused = paused
    this.audio.setDangerAlarm(!paused && this.heroHp > 0 && this.heroHp <= this.heroMaxHp * 0.3 && this.phase === 'fighting')
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
    if (muted) this.audio.setDangerAlarm(false)
  }

  /**
   * 喂入 MediaPipe Pose 2D + 3D 世界骨骼帧：
   * 实时把全身动作重定向给迪迦（头、脊柱、双臂、双手、双腿、下蹲与起跳），同时识别招式特效
   */
  public feedPoseLandmarks(
    landmarks: PoseLandmark[] | null,
    worldLandmarks: PoseLandmark[] | null,
    now: number,
    width: number,
    height: number,
    laneCenter?: number,
  ) {
    if (this.controlMode !== 'camera') return
    const snap = this.gesture.update(landmarks, now, width, height, worldLandmarks, !!this.heroProfile.forms, laneCenter)
    this.gestureTracking = snap.tracking
    const fullBody = snap.coverage === 'full' && canTrackFeet(landmarks)
    const physicalKick = fullBody && this.feetTracked ? snap.kick : null
    this.feetTracked = fullBody
    this.gestureCoverage = fullBody ? 'full' : snap.tracking ? 'upper' : 'none'
    this.gestureLean = snap.lean
    this.gestureGuard = snap.guard
    this.gestureBeamCharge = snap.beamCharge
    this.gestureBeamArmSide = snap.beamArmSide
    this.gestureDiscCharge = snap.discCharge
    this.gestureDiscSide = snap.discSide
    this.gestureTypeCharge = snap.typeCharge
    this.gestureHintKey = !physicalKick && snap.hintKey === 'hintKick' ? 'hintReady' : snap.hintKey
    if (snap.livePose && !fullBody) snap.livePose.coverage = 'upper'

    // 实时驱动迪迦全身肢体同步玩家！
    this.hero.setLiveBodyPose(snap.livePose, now)

    if (this.phase !== 'fighting') return

    const jumped = this.jump.update(!fullBody && snap.tracking ? landmarks : null, now, width / height)
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

  // ---- 手动 / 键盘 / 触屏快捷操作接口 ----

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
    this.manualGuard = active
  }

  public triggerManualPunch(side: 'left' | 'right') {
    if (this.phase !== 'fighting') return
    this.executePunch(side)
  }

  public triggerManualKick(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    this.executeKick(side)
  }

  public triggerManualDisc(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    this.executeDisc(side)
  }

  public triggerManualBeam() {
    if (this.phase !== 'fighting') return
    this.executeBeam()
  }

  // ---- 核心招式执行（体感模式下特效严格跟随真实手脚发射，不强行覆盖肢体姿态） ----

  private executePunch(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive()) return
    this.hero.triggerAction(side === 'left' ? 'punch-left' : 'punch-right', 0.28)
    const origin = this.hero.getFistOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.punchChain = this.chainTimeLeft > 0 && this.lastPunchSide !== side ? this.punchChain + 1 : 1
    const finisher = this.punchChain === 3
    this.lastPunchSide = side
    this.chainTimeLeft = finisher ? 0 : 1.4
    const damage = Math.round((finisher ? 58 : 28) * this.formDamageMul)
    this.effects.spawnPunchWave(origin, target, damage, side, finisher)
    this.effects.spawnBurst(origin, this.heroProfile.burstColor, 6, 12, 0.55)
    this.audio.playSwing(side, false)
  }

  private executeKick(side: 'left' | 'right', jumping = false) {
    if (this.effects.isHeroBeamActive()) return
    const action = jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right'
    this.hero.triggerAction(action, jumping ? 0.46 : 0.36)
    const origin = this.hero.getFootOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnKickWave(origin, target, Math.round((jumping ? 64 : 46) * this.formDamageMul))
    this.effects.spawnBurst(origin, 0xf97316, 10, 16, 0.8)
    this.audio.playSwing(side, true)
    this.showBanner(jumping ? 'bannerJumpKick' : 'bannerKick', 0.85)
  }

  private executeDisc(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive() || this.discCooldown > 0) return
    this.discCooldown = 1.6
    this.hero.setDiscCharge(0, side)
    this.hero.triggerAction('disc', 0.42)
    const origin = this.hero.getDiscOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnUltraDisc(origin, target, Math.round(76 * this.formDamageMul))
    this.audio.playDisc()
    this.showBanner(`bannerDisc${this.heroProfile.bannerKey}`, 1.0)
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
    this.beamCooldown = 2.0
    const dur = isSuper ? 1.75 : 1.25
    this.hero.triggerAction('beam', dur)
    this.effects.startHeroBeam(isSuper)
    this.audio.playBeam(isSuper)
    this.addTrauma(isSuper ? 0.7 : 0.45)
    this.beamDamageTicksRemaining = isSuper ? 5 : 4
    this.beamDamagePerTick = Math.round((isSuper ? 48 : 32) * this.formDamageMul)
    this.beamTickTimer = 0.16
    this.showBanner(
      isSuper ? `bannerSuperBeam${this.heroProfile.bannerKey}` : `bannerBeam${this.heroProfile.bannerKey}`,
      dur,
    )
    this.emitHud()
  }

  private showBanner(key: string, duration: number) {
    this.skillBannerKey = key
    this.skillBannerTimer = duration
  }

  /** 叠加镜头 trauma（打击感：trauma² 多频震动，命中/受击/爆炸分级注入） */
  private addTrauma(amount: number) {
    this.shakeTrauma = Math.min(1.15, this.shakeTrauma + amount)
  }

  /** 命中顿帧：短时间内把世界时间压缩到 12%，让每一记命中都有"砸实"的定格瞬间 */
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
    amount = this.kaiju.encounter.receiveHit(amount, impact, id === 'zetton' || id === 'gomora-mecha')
    this.monsterHp = Math.max(0, this.monsterHp - amount)
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.comboResetTimer = 3.2
    this.score += amount * (10 + Math.min(20, this.combo))

    const hitPos = this.kaiju.getTargetCenter()
    if (punchSide) hitPos.x += punchSide === 'left' ? -1.8 : 1.8
    this.kaiju.triggerHitFlash(isCritical ? 1 : 0.72, punchSide)
    this.effects.spawnBurst(
      hitPos,
      isCritical ? 0xfacc15 : this.heroProfile.beamColor,
      isCritical ? 22 : 12,
      isCritical ? 26 : 18,
      isCritical ? 1.25 : 0.9,
    )

    if (impact === 'heavy') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime)
      this.addHitStop(0.085)
      this.addTrauma(0.42)
      this.effects.spawnImpactRing(hitPos, 0xffffff, 8.5)
      this.effects.spawnHitFlash(hitPos, isCritical ? 0xfef08a : 0xffffff, 1.35)
    } else if (impact === 'light') {
      this.addHitStop(0.05)
      this.addTrauma(0.26)
      this.effects.spawnImpactRing(hitPos, 0xffffff, 5.5)
      this.effects.spawnHitFlash(hitPos, 0xffffff, 1.0)
    } else {
      this.addTrauma(0.12)
      this.effects.spawnHitFlash(hitPos, this.heroProfile.beamColor, 0.9)
    }

    this.spawnFloatingAtWorld(
      hitPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 2.5, 0)),
      `-${amount}${isCritical ? '!' : ''}`,
      color,
      isCritical ? 1.3 : 1.0,
    )

    if (this.monsterHp <= 0) {
      this.onMonsterDefeated()
    }
    this.emitHud()
  }

  private onMonsterDefeated() {
    this.defeatedCount += 1
    this.score += 1500 + this.waveIndex * 600
    this.beamDamageTicksRemaining = 0
    this.kaiju.encounter.enter('dying')
    this.audio.playExplosion()
    this.addHitStop(0.12)
    this.addTrauma(0.95)

    const center = this.kaiju.getTargetCenter()
    this.effects.spawnImpactRing(center, 0xffd28a, 14)
    this.effects.spawnBurst(center, 0xff6b2b, 38, 34, 1.8)
    this.effects.spawnBurst(center.clone().add(new THREE.Vector3(0, 3, 1)), 0xfacc15, 28, 28, 1.5)

    if (this.waveIndex + 1 >= MONSTER_WAVES.length) {
      this.phase = 'victory'
      this.audio.setDangerAlarm(false)
      this.hero.triggerAction('victory', 5)
      this.audio.playVictory()
      this.showBanner('bannerVictory', 3.5)
    } else {
      this.phase = 'wave-clear'
      this.waveTransitionTimer = 2.6
      this.showBanner('bannerWaveClear', 2.2)
    }
    this.emitHud()
  }

  private applyAttackOnHero(damage: number, attack: MonsterAttackKind, attackX: number) {
    if (this.phase !== 'fighting') return

    if (this.effects.isHeroBeamActive()) {
      this.effects.spawnBurst(
        new THREE.Vector3(this.hero.currentX, 9.5, this.hero.baseZ - 2.5),
        0x7dd3fc,
        14,
        18,
      )
      return
    }

    if (attack === 'fireball' && Math.abs(this.hero.currentX - attackX) > 3.1) {
      this.energy = Math.min(100, this.energy + 12)
      this.score += 200
      this.spawnFloatingAtWorld(
        new THREE.Vector3(this.hero.currentX, 14.5, this.hero.baseZ),
        'DODGE!',
        '#4ade80',
        1.15,
      )
      this.emitHud()
      return
    }

    const isGuarding = this.isHeroGuarding()
    if (isGuarding) {
      if (attack === 'melee' && this.kaiju.encounter.state === 'attack') {
        this.kaiju.encounter.enter('staggered')
      }
      this.perfectGuards += 1
      this.energy = Math.min(100, this.energy + 25)
      this.score += 350
      this.audio.playGuardBlock()
      this.effects.triggerShieldBlockFlash()
      this.effects.spawnBurst(
        new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 3.0),
        0xfef08a,
        20,
        22,
        1.1,
      )
      this.effects.spawnImpactRing(
        new THREE.Vector3(this.hero.currentX, 9.0, this.hero.baseZ - 3.0),
        0xbae6fd,
        6.5,
      )
      this.addHitStop(0.045)
      this.addTrauma(0.32)
      this.spawnFloatingAtWorld(
        new THREE.Vector3(this.hero.currentX, 14.8, this.hero.baseZ),
        'PERFECT GUARD!',
        '#38bdf8',
        1.2,
      )
      this.showBanner('bannerPerfectGuard', 0.9)
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
    this.addTrauma(0.58)
    this.effects.spawnBurst(
      new THREE.Vector3(this.hero.currentX, 9.5, this.hero.baseZ - 1.2),
      0xff4444,
      18,
      20,
      1.1,
    )
    this.effects.spawnImpactRing(
      new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 1.4),
      0xffb3b3,
      6,
    )
    this.effects.spawnHitFlash(
      new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 1.4),
      0xff8888,
      1.1,
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

  private spawnFloatingAtWorld(worldPos: THREE.Vector3, text: string, color: string, scale = 1) {
    const projected = worldPos.clone().project(this.camera)
    const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * 100, 12, 88)
    const y = THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * 100, 14, 82)
    this.callbacks.onFloatingText({
      id: this.floatingIdCounter++,
      text,
      color,
      x,
      y,
      scale,
    })
  }

  // ---- 主循环 ----

  private loop = (now: number) => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.loop)

    const rawDt = Math.min(0.05, Math.max(0.001, (now - this.lastTimestamp) / 1000))
    this.lastTimestamp = now
    if (this.paused) return
    this.elapsedTime += rawDt

    // 命中顿帧：世界时间压缩，镜头平滑与震动衰减仍走真实时间
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
      this.manualLean !== 0 ? this.manualLean : this.controlMode === 'camera' ? this.gestureLean : 0
    const guarding = this.isHeroGuarding()

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
    this.arena.update(this.elapsedTime)

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

    this.effects.update(dt, this.elapsedTime, beamSeg, kaijuTarget, kaijuEmit, heroCenter)
    this.effects.updateShield(guarding, this.hero.currentX, this.hero.baseZ, dt, this.elapsedTime)
    this.effects.updateChargePreview(
      this.controlMode === 'camera' ? this.gestureBeamCharge : 0,
      beamSeg[0].clone().lerp(beamSeg[1], 0.55),
      this.controlMode === 'camera' ? this.gestureDiscCharge : 0,
      this.hero.getDiscOrigin(this.gestureDiscSide ?? 'right'),
      this.elapsedTime,
    )
    this.effects.updateTypeCharge(
      this.controlMode === 'camera' && this.heroProfile.forms ? this.gestureTypeCharge : 0,
      new THREE.Vector3(this.hero.currentX, 15.5, this.hero.baseZ + 0.5),
      this.activeForm?.accentColor ?? 0xb388ff,
      this.elapsedTime,
    )

    const fight = this.kaiju.encounter
    const isWarning = this.phase === 'fighting' && fight.state === 'windup'
    this.effects.updateWarningRing(
      isWarning,
      fight.attack === 'fireball' ? fight.targetX : this.hero.currentX,
      isWarning ? fight.time / WINDUP_TIME : 0,
      this.elapsedTime,
    )

    this.updateCamera(rawDt)

    this.hudSyncAccumulator += dt
    if (this.hudSyncAccumulator >= 0.08) {
      this.hudSyncAccumulator = 0
      this.emitHud()
    }
  }

  private stepCombat(dt: number) {

    if (this.beamDamageTicksRemaining > 0) {
      this.beamTickTimer -= dt
      if (this.beamTickTimer <= 0) {
        this.beamTickTimer = 0.24
        this.beamDamageTicksRemaining -= 1
        this.applyDamageToMonster(this.beamDamagePerTick, '#38e8ff', true, 'beam')
      }
    }

    const kaijuCenter = this.kaiju.getTargetCenter()
    for (const proj of this.effects.projectiles) {
      if (this.phase !== 'fighting') return
      if (proj.hitTriggered) continue

      if (proj.fromHero) {
        if (proj.pos.z <= kaijuCenter.z + 4.5) {
          proj.hitTriggered = true
          if (proj.kind === 'punch-wave') {
            this.energy = Math.min(100, this.energy + 12)
            if (proj.finisher) {
              this.audio.playHeavyImpact()
              this.showBanner('bannerTriple', 1)
            } else {
              this.audio.playPunch(true)
            }
            this.applyDamageToMonster(
              proj.damage, '#fde047', proj.finisher, proj.finisher ? 'heavy' : 'light', proj.punchSide,
            )
          } else if (proj.kind === 'kick-wave') {
            this.energy = Math.min(100, this.energy + 16)
            this.audio.playHeavyImpact()
            this.applyDamageToMonster(proj.damage, '#fb923c', true, 'heavy')
          } else if (proj.kind === 'ultra-disc') {
            this.energy = Math.min(100, this.energy + 18)
            this.audio.playHeavyImpact()
            if (this.kaiju.encounter.state === 'windup') {
              this.kaiju.encounter.enter('staggered')
              this.showBanner('bannerInterrupt', 1.0)
            }
            this.applyDamageToMonster(proj.damage, '#67e8f9', true, 'heavy')
          }
        }
      } else {
        if (proj.pos.z >= this.hero.baseZ - 2.6) {
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
    const event: EncounterEvent | undefined = fight.advance(dt, fighting, this.monsterHp / this.monsterMaxHp, this.hero.currentX, spec)
    if (event === 'warn') {
      this.audio.playWarning()
      this.emitHud()
    } else if (event === 'land' || event === 'roar' || event === 'collapse') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime)
      this.addTrauma(event === 'roar' ? 0.32 : 0.45)
      if (event === 'roar') this.audio.playRoar()
    } else if (event === 'strike') {
      if (fight.attack === 'fireball') {
        this.effects.spawnKaijuFireball(
          this.kaiju.getAttackEmitOrigin(),
          new THREE.Vector3(fight.targetX, 9.2, this.hero.baseZ),
          spec.accentColor, spec.attackDamage,
        )
      } else {
        if (fight.attack === 'dark-beam') this.effects.startKaijuBeam(spec.accentColor)
        this.applyAttackOnHero(spec.attackDamage + (fight.attack === 'dark-beam' ? 4 : 0), fight.attack, fight.targetX)
      }
    }
  }

  private updateCamera(dt: number) {
    const targetCam = this.baseCamPos.clone()
    const targetLook = this.camLookAt.clone()

    if (this.phase === 'victory') {
      targetCam.set(3.5, 9.5, 36)
      targetLook.copy(this.hero.root.position).add(new THREE.Vector3(0, 7, 0))
    } else if (this.effects.isHeroBeamActive()) {
      const sideSign = this.gestureBeamArmSide === 'left' ? -1 : 1
      targetCam.set(this.hero.currentX * 0.4 + sideSign * 10.5, 11.4, 27.5)
      targetLook.set(this.kaiju.currentX * 0.4, 9.6, 4.5)
    } else {
      // 战斗机位：相机与视线以相同权重跟随英雄水平位移（0.45），英雄稳居画面中带
      targetCam.set(this.hero.currentX * 0.45 + 2.4, 13.8, 35.6)
      targetLook.set(
        this.hero.currentX * 0.45 + this.kaiju.currentX * 0.15 - 1.9,
        8.6,
        -5,
      )
    }

    if ((this.phase === 'intro' || this.phase === 'fighting' || this.phase === 'wave-clear') && !this.effects.isHeroBeamActive()) {
      // 越肩构图留出对手的轮廓，能看清怪兽架臂和失衡时的动作。
      targetCam.x += 5.5
      targetCam.z += 2
      targetLook.x += 0.8
    }
    this.cameraAnchor.lerp(targetCam, 1 - Math.exp(-dt * 6.5))
    this.camera.position.copy(this.cameraAnchor)

    // trauma² 多频正弦镜头震动：幅度随 trauma 平方衰减，比随机抖动更"重"更有特摄冲击感
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.7)
    const shakeAmount = this.shakeTrauma * this.shakeTrauma * 1.5
    if (shakeAmount > 0.001) {
      const t = this.elapsedTime
      this.camera.position.x += (Math.sin(t * 47.3) * 0.62 + Math.sin(t * 31.7) * 0.38) * shakeAmount
      this.camera.position.y += (Math.sin(t * 39.1) * 0.62 + Math.sin(t * 27.3) * 0.38) * shakeAmount
      this.camera.position.z += Math.sin(t * 23.9) * 0.3 * shakeAmount
    }

    this.camera.lookAt(targetLook)
    if (shakeAmount > 0.001) {
      this.camera.rotation.z += Math.sin(this.elapsedTime * 35.7) * 0.035 * shakeAmount
    }
  }

  public getHudSnapshot(): BattleHudState {
    const spec = MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!
    const fight = this.kaiju.encounter
    let warningTextKey: string | null = null
    if (this.phase === 'fighting' && fight.state === 'windup') {
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

    return {
      phase: this.phase,
      loadingProgress: this.loadingProgress,
      heroId: this.heroProfile.id,
      heroForm: this.activeForm?.id ?? 'base',
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
      activeSkillBannerKey: this.skillBannerKey,
      tracking: this.gestureTracking,
      bodyCoverage: this.gestureCoverage,
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
    this.effects.clearAllDynamic()
    this.kaiju.clearCurrentModel()
    this.arena.dispose()
    this.hero.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
