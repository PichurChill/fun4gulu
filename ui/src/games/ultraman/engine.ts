import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { UltraAudio } from './audio'
import { BattleEffects } from './effects'
import { ArenaManager } from './environment'
import { UltraGestureRecognizer } from './gesture'
import { HERO_PROFILES } from './heroes'
import { HeroController } from './hero'
import type { HeroId, HeroProfile } from './heroes'
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
  public readonly gesture = new UltraGestureRecognizer()
  private readonly arena: ArenaManager
  private readonly hero: HeroController
  private readonly kaiju: KaijuController
  private readonly effects: BattleEffects

  private rafId = 0
  private lastTimestamp = 0
  private elapsedTime = 0
  private disposed = false
  private assetsReady = false

  // 游戏状态机
  private phase: GamePhase = 'menu'
  private heroProfile: HeroProfile = HERO_PROFILES.tiga
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
  private combo = 0
  private maxCombo = 0
  private comboResetTimer = 0
  private perfectGuards = 0
  private defeatedCount = 0

  // 怪兽攻击节奏控制
  private monsterAttackCooldown = 2.6
  private monsterWindupTimer = 0
  private pendingAttack: MonsterAttackKind = 'fireball'
  private attackResolved = false
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

  // 镜头与提示动效（打击感：命中顿帧 + trauma² 多频镜头震动）
  private hitStopTimer = 0
  private shakeTrauma = 0
  private skillBannerKey: string | null = null
  private skillBannerTimer = 0
  private floatingIdCounter = 1
  private hudSyncAccumulator = 0
  private readonly baseCamPos = new THREE.Vector3(3.6, 13.8, 35.6)
  private readonly camLookAt = new THREE.Vector3(-0.3, 8.6, -5)

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
  public setSceneTheme(theme: SceneTheme, previewWaveIndex?: number) {
    this.preferredTheme = theme
    const concrete = this.resolveThemeForWave(previewWaveIndex ?? this.waveIndex)
    this.arena.setTheme(concrete)
    this.emitHud()
  }

  private resolveThemeForWave(waveIdx: number): ConcreteSceneTheme {
    if (this.preferredTheme !== 'auto') return this.preferredTheme
    return MONSTER_WAVES[waveIdx]?.defaultTheme ?? 'seaside'
  }

  /** 预加载当前英雄模型、城市建筑与第 1 关怪兽 */
  public async preloadBaseAssets(): Promise<void> {
    if (this.assetsReady) return
    this.loadingProgress = 15
    this.emitHud()

    await this.hero.load(this.loader, this.heroProfile)
    this.loadingProgress = 55
    this.emitHud()

    await Promise.all([
      this.arena.loadCityBuildings(this.loader),
      this.kaiju.spawn(this.loader, MONSTER_WAVES[0]!),
    ])
    this.kaiju.setState('idle')
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
    this.effects.setHeroTheme(profile)
    this.emitHud()
    if (this.phase !== 'menu' || !this.assetsReady) return
    this.loadingProgress = 40
    this.emitHud()
    await this.hero.load(this.loader, profile)
    this.hero.resetPose()
    this.loadingProgress = 100
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
    this.gesture.reset()
    this.effects.clearAllDynamic()

    this.phase = 'loading'
    this.loadingProgress = this.assetsReady ? 65 : 10
    this.emitHud()

    if (!this.assetsReady) {
      await this.preloadBaseAssets()
    }

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
    this.hero.resetPose()
    this.audio.setDangerAlarm(false)
    this.audio.playTransform()

    await this.loadWave(this.waveIndex)
  }

  private async loadWave(index: number): Promise<void> {
    const spec = MONSTER_WAVES[index]!
    this.waveIndex = index
    this.monsterMaxHp = spec.maxHp
    this.monsterHp = spec.maxHp
    this.monsterAttackCooldown = 2.4
    this.monsterWindupTimer = 0
    this.attackResolved = false
    this.beamDamageTicksRemaining = 0
    this.effects.clearAllDynamic()

    // 自动切换或保持指定场景主题
    this.arena.setTheme(this.resolveThemeForWave(index))

    this.phase = 'loading'
    this.loadingProgress = 75
    this.emitHud()

    await this.kaiju.spawn(this.loader, spec)
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
    this.kaiju.setState('idle')
    this.emitHud()
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
  ) {
    if (this.controlMode !== 'camera') return
    const snap = this.gesture.update(landmarks, now, width, height, worldLandmarks)
    this.gestureTracking = snap.tracking
    this.gestureCoverage = snap.coverage
    this.gestureLean = snap.lean
    this.gestureGuard = snap.guard
    this.gestureBeamCharge = snap.beamCharge
    this.gestureBeamArmSide = snap.beamArmSide
    this.gestureDiscCharge = snap.discCharge
    this.gestureDiscSide = snap.discSide
    this.gestureHintKey = snap.hintKey

    // 实时驱动迪迦全身肢体同步玩家！
    this.hero.setLiveBodyPose(snap.livePose, now)

    if (this.phase !== 'fighting') return

    if (snap.beamTrigger) {
      this.executeBeam()
    } else if (snap.discTrigger) {
      this.executeDisc(snap.discTrigger)
    } else if (snap.kick) {
      this.executeKick(snap.kick)
    } else if (snap.punch) {
      this.executePunch(snap.punch)
    }
  }

  // ---- 手动 / 键盘 / 触屏快捷操作接口 ----

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
    this.effects.spawnPunchWave(origin, target, 28)
    this.effects.spawnBurst(origin, this.heroProfile.burstColor, 6, 12, 0.55)
    this.audio.playPunch(false)
  }

  private executeKick(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive()) return
    this.hero.triggerAction(side === 'left' ? 'kick-left' : 'kick-right', 0.36)
    const origin = this.hero.getFootOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnKickWave(origin, target, 46)
    this.effects.spawnBurst(origin, 0xf97316, 10, 16, 0.8)
    this.audio.playPunch(false)
    this.showBanner('bannerKick', 0.85)
  }

  private executeDisc(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive() || this.discCooldown > 0) return
    this.discCooldown = 1.6
    this.hero.setDiscCharge(0, side)
    this.hero.triggerAction('disc', 0.42)
    const origin = this.hero.getDiscOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnUltraDisc(origin, target, 76)
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
    this.beamDamagePerTick = isSuper ? 48 : 32
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
    impact: 'light' | 'heavy' | 'beam' = 'light',
  ) {
    if (this.phase !== 'fighting' || this.monsterHp <= 0) return

    this.monsterHp = Math.max(0, this.monsterHp - amount)
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.comboResetTimer = 3.2
    this.score += amount * (10 + Math.min(20, this.combo))

    const hitPos = this.kaiju.getTargetCenter()
    this.kaiju.triggerHitFlash(isCritical ? 1 : 0.72)
    this.effects.spawnBurst(
      hitPos,
      isCritical ? 0xfacc15 : this.heroProfile.beamColor,
      isCritical ? 22 : 12,
      isCritical ? 26 : 18,
      isCritical ? 1.25 : 0.9,
    )

    if (impact === 'heavy') {
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
    this.monsterWindupTimer = 0
    this.beamDamageTicksRemaining = 0
    this.kaiju.setState('dying')
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

  private applyAttackOnHero(damage: number, canDodgeByLean: boolean, attackX: number) {
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

    if (canDodgeByLean && Math.abs(this.hero.currentX - attackX) > 3.1) {
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
    this.hero.update(dt, this.elapsedTime, dangerTimer, nowMs)
    this.kaiju.update(dt, this.elapsedTime)
    this.arena.update(dt, this.elapsedTime)

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

    const isWarning = this.phase === 'fighting' && this.monsterWindupTimer > 0
    this.effects.updateWarningRing(
      isWarning,
      this.hero.currentX,
      isWarning ? 1 - this.monsterWindupTimer / 1.35 : 0,
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
    const spec = MONSTER_WAVES[this.waveIndex]!

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
      const proj = this.effects.projectiles[i]!
      if (proj.hitTriggered) continue

      if (proj.fromHero) {
        if (proj.pos.z <= kaijuCenter.z + 4.5) {
          proj.hitTriggered = true
          if (proj.kind === 'punch-wave') {
            this.energy = Math.min(100, this.energy + 12)
            this.audio.playPunch(true)
            this.applyDamageToMonster(proj.damage, '#fde047', false, 'light')
          } else if (proj.kind === 'kick-wave') {
            this.energy = Math.min(100, this.energy + 16)
            this.audio.playHeavyImpact()
            this.applyDamageToMonster(proj.damage, '#fb923c', true, 'heavy')
          } else if (proj.kind === 'ultra-disc') {
            this.energy = Math.min(100, this.energy + 18)
            this.audio.playHeavyImpact()
            if (this.monsterWindupTimer > 0) {
              this.monsterWindupTimer = 0
              this.monsterAttackCooldown = spec.attackInterval * 0.85
              this.kaiju.setState('hit')
              this.showBanner('bannerInterrupt', 1.0)
            }
            this.applyDamageToMonster(proj.damage, '#67e8f9', true, 'heavy')
          }
        }
      } else {
        if (proj.pos.z >= this.hero.baseZ - 2.6) {
          proj.hitTriggered = true
          this.applyAttackOnHero(proj.damage, true, proj.pos.x)
        }
      }
    }

    if (this.monsterHp <= 0 || this.kaiju.state === 'entering' || this.kaiju.state === 'dying') {
      return
    }

    if (this.monsterWindupTimer > 0) {
      this.monsterWindupTimer -= dt
      if (this.monsterWindupTimer <= 0) {
        this.kaiju.setState('attack', this.pendingAttack)
        this.attackResolved = false
        if (this.pendingAttack === 'fireball') {
          const origin = this.kaiju.getAttackEmitOrigin()
          const target = new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ)
          this.effects.spawnKaijuFireball(origin, target, spec.accentColor, spec.attackDamage)
          this.attackResolved = true
        } else if (this.pendingAttack === 'dark-beam') {
          this.effects.startKaijuBeam(spec.accentColor)
          this.applyAttackOnHero(spec.attackDamage + 4, false, this.hero.currentX)
          this.attackResolved = true
        }
        this.monsterAttackCooldown = spec.attackInterval
      }
    } else if (
      this.kaiju.state === 'attack' &&
      this.pendingAttack === 'melee' &&
      !this.attackResolved
    ) {
      if (this.kaiju.stateTime >= 0.28) {
        this.attackResolved = true
        this.applyAttackOnHero(spec.attackDamage, false, this.hero.currentX)
      }
    } else {
      this.monsterAttackCooldown -= dt
      if (this.monsterAttackCooldown <= 0) {
        const attacks = spec.attacks
        this.pendingAttack = attacks[Math.floor(Math.random() * attacks.length)]!
        this.monsterWindupTimer = 1.35
        this.kaiju.setState('windup', this.pendingAttack)
        this.audio.playWarning()
        this.emitHud()
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
      targetCam.set(this.hero.currentX * 0.45 + 3.6, 13.8, 35.6)
      targetLook.set(this.hero.currentX * 0.18 + this.kaiju.currentX * 0.25 - 0.3, 8.6, -5)
    }

    this.camera.position.lerp(targetCam, Math.min(1, dt * 6.5))

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
    let warningTextKey: string | null = null
    if (this.phase === 'fighting' && this.monsterWindupTimer > 0) {
      warningTextKey =
        this.pendingAttack === 'fireball'
          ? 'warningFireball'
          : this.pendingAttack === 'dark-beam'
            ? 'warningDarkBeam'
            : 'warningMelee'
    }

    let chargeKind: 'beam' | 'disc' | 'guard' | null = null
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
    }

    return {
      phase: this.phase,
      loadingProgress: this.loadingProgress,
      heroId: this.heroProfile.id,
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
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfectGuards: this.perfectGuards,
      defeatedCount: this.defeatedCount,
      warningTextKey,
      warningUrgency:
        this.monsterWindupTimer > 0
          ? THREE.MathUtils.clamp(1 - this.monsterWindupTimer / 1.35, 0, 1)
          : 0,
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
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
