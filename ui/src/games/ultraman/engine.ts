import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { UltraAudio } from './audio'
import { BattleEffects } from './effects'
import { WINDUP_TIME } from './encounter'
import type { EncounterEvent, Impact } from './encounter'
import { ArenaManager } from './environment'
import { UltraGestureRecognizer } from './gesture'
import type { HandLandmarksInput } from './gesture'
import { canTrackFeet, JumpKickRecognizer } from './jump'
import { HERO_PROFILES } from './heroes'
import { HeroController } from './hero'
import type { HeroFormSpec, HeroId, HeroProfile } from './heroes'
import { KaijuController, MONSTER_WAVES } from './monsters'
import type {
  ActionGuideKind,
  BattleHudState,
  BattleStage,
  ConcreteSceneTheme,
  ControlMode,
  FloatingDamageEvent,
  GamePhase,
  HeroAction,
  MonsterAttackKind,
  PoseLandmark,
  SceneTheme,
} from './types'

export interface EngineCallbacks {
  onHudUpdate: (state: BattleHudState) => void
  onFloatingText: (evt: FloatingDamageEvent) => void
}

const DISC_MAX_COOLDOWN = 1.8
const BEAM_MAX_COOLDOWN = 2.2
const MELEE_PUNCH_COOLDOWN = 0.3
const RANGED_PALM_COOLDOWN = 0.34
const KICK_MIN_COOLDOWN = 0.48

const MELEE_COMBO_ACTIONS: readonly HeroAction[] = [
  'combo-1',
  'combo-2',
  'combo-3',
  'combo-4',
  'combo-5',
]

const MELEE_SLASH_STYLES: readonly { color: number; euler: [number, number, number]; spin: number }[] = [
  { color: 0xff5a2c, euler: [0.25, 0.2, -0.55], spin: -1 },
  { color: 0xfacc15, euler: [-0.2, -0.25, 2.45], spin: 1 },
  { color: 0x38e8ff, euler: [0.55, 0.15, 0.85], spin: -1 },
  { color: 0xf97316, euler: [-0.35, 0.1, -1.2], spin: 1 },
  { color: 0xff2e63, euler: [1.22, 0.1, 0], spin: -1.6 },
]

/**
 * 悦动元气机级 3D 特摄体感超激斗主引擎：
 * - 选择性 UnrealBloomPass 电影级辉光渲染管线（严格防 NaN，突出复眼/刀光/护盾/烈焰/光线）
 * - 五幕无缝电影式战斗流程：
 *   0) 宇宙星海体感举手变身仪式
 *   1) 近身贴脸 5 段刀光拳脚肉搏 + 全身球形蓝色护盾弹反
 *   2) 过场正面特写 -> 正后方远程大步闪避巨型熔岩火球 + 掌心光弹连射
 *   3) 侧面超近景角力推力 QTE -> 霸气过肩摔砸飞怪兽 + 后空翻落地起身特写
 *   4) 残血处决二段必杀光线：正面展臂七彩棱镜聚能 -> 高空俯拍闪电超级光线轰爆
 *   5) 宇宙星海英雄合影结算
 */
export class UltramanGameEngine {
  private readonly container: HTMLElement
  private readonly callbacks: EngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly composer: EffectComposer
  private readonly bloomPass: UnrealBloomPass
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

  // 游戏核心状态机与五幕导演状态
  private phase: GamePhase = 'menu'
  private battleStage: BattleStage = 'melee'
  private stageTimer = 0
  private rangedTriggered = false
  private grappleTriggered = false
  private finisherTriggered = false
  private rangedFireballTimer = 1.4
  private rangedLaneCursor = 0

  private heroProfile: HeroProfile = HERO_PROFILES.tiga
  private heroFormIndex = 0
  private controlMode: ControlMode = 'camera'
  private preferredTheme: SceneTheme = 'auto'
  private loadingProgress = 0
  private waveIndex = 0
  private monsterHp = 1100
  private monsterMaxHp = 1100
  private heroHp = 100
  private readonly heroMaxHp = 100
  private energy = 50
  private score = 0
  private punchChain = 0
  private comboStep = 0
  private lastPunchSide: 'left' | 'right' | null = null
  private chainTimeLeft = 0
  private combo = 0
  private maxCombo = 0
  private comboResetTimer = 0
  private perfectGuards = 0
  private defeatedCount = 0

  private waveTransitionTimer = 0

  // 变身、角力、二段终结光线状态
  private transformProgress = 0
  private transformBurstPlayed = false
  private transformHoldAfterTrigger = 0
  private grappleProgress = 0.48
  private grappleTimeLeft = 0
  private grappleSfxCooldown = 0
  private finisherSpreadProgress = 0
  private finisherBeamFired = false
  private finisherBeamWaitTimer = 0
  private finisherTickTimer = 0
  private rainbowSfxCooldown = 0
  private lastDodgeTriggerAt = -Infinity

  // 招式、防御时机与双光线对波状态
  private beamDamageTicksRemaining = 0
  private beamTickTimer = 0
  private beamDamagePerTick = 28
  private beamCooldown = 0
  private discCooldown = 0
  private punchCooldown = 0
  private kickCooldown = 0
  private beamClashActive = false
  private beamClashTimer = 0
  private beamClashProgress = 0.5

  private manualLean = 0
  private manualGuard = false
  private manualSpreadHeld = false
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
  private gestureSpreading = false
  private gestureStrugglePower = 0
  private gestureTransformProgress = 0

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
    const isTouchDevice =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window)
    const dpr = Math.min(window.devicePixelRatio || 1, isTouchDevice ? 1.35 : 1.5)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.02

    container.appendChild(this.renderer.domElement)

    // 选择性电影辉光后处理管线（阈值 0.96 + 克制强度 0.24，保证头雕、胸甲与都市轮廓纤毫毕现零白雾）
    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.24, 0.24, 0.96)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())

    this.arena = new ArenaManager(this.scene, this.renderer)
    this.hero = new HeroController(this.scene, { baseZ: 7.0 })
    this.kaiju = new KaijuController(this.scene)
    this.effects = new BattleEffects(this.scene)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.lastTimestamp = performance.now()
    this.loop(this.lastTimestamp)
  }

  /** 为胜利合影强制渲染最新一帧并返回 WebGL 画布元素 */
  public getSnapshotCanvas(): HTMLCanvasElement {
    this.composer.render()
    return this.renderer.domElement
  }

  private handleResize() {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth || window.innerWidth)
    const h = Math.max(1, this.container.clientHeight || window.innerHeight)
    this.viewportAspect = w / h
    this.camera.aspect = this.viewportAspect
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.bloomPass.setSize(w, h)
  }

  public async setSceneTheme(theme: SceneTheme, previewWaveIndex?: number) {
    this.preferredTheme = theme
    const concrete = this.resolveThemeForWave(previewWaveIndex ?? this.waveIndex)
    await this.arena.setTheme(concrete)
    this.emitHud()
  }

  private resolveThemeForWave(waveIdx: number): ConcreteSceneTheme {
    if (this.preferredTheme !== 'auto') return this.preferredTheme
    return MONSTER_WAVES[waveIdx]?.defaultTheme ?? 'city'
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
    const spec = MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!
    this.audio.setHero(this.heroProfile.id)
    this.audio.setMonster(spec.id)
    await Promise.all([
      this.hero.load(this.loader, this.heroProfile),
      this.arena.setTheme(this.resolveThemeForWave(this.waveIndex)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed) return
    let preview: HeroProfile
    do {
      preview = this.heroProfile
      await this.hero.load(this.loader, preview)
      if (this.disposed) return
    } while (preview !== this.heroProfile)
    this.hero.setStageBaseZ(11.8, true)
    this.kaiju.setStageAnchor(-5.2, 11.8)
    this.kaiju.encounter.enter('idle')
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.85)
    this.loadingProgress = 100
    this.assetsReady = true
    this.emitHud()
  }

  public async setHero(heroId: HeroId): Promise<void> {
    const profile = HERO_PROFILES[heroId]
    if (profile.id === this.heroProfile.id) return
    this.heroProfile = profile
    this.heroFormIndex = 0
    this.audio.setHero(profile.id)
    this.applyHeroForm()
    this.emitHud()
    if (this.phase !== 'menu' || !this.assetsReady) return
    this.loadingProgress = 40
    this.emitHud()
    await this.hero.load(this.loader, profile)
    if (this.disposed || profile !== this.heroProfile || this.phase !== 'menu') return
    this.hero.resetPose()
    this.hero.setStageBaseZ(11.6, true)
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.85)
    const burstPos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.2, -0.8))
    this.effects.spawnBurst(burstPos, profile.accentColor, 18, 18, 1.1)
    this.effects.spawnImpactRing(burstPos, profile.accentColor, 5.5)
    this.loadingProgress = 100
    this.emitHud()
  }

  public async previewWave(waveIdx: number) {
    const clamped = THREE.MathUtils.clamp(waveIdx, 0, MONSTER_WAVES.length - 1)
    this.waveIndex = clamped
    if (this.phase !== 'menu' || !this.assetsReady) return
    const spec = MONSTER_WAVES[clamped]!
    this.audio.setMonster(spec.id)
    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(clamped)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed || this.phase !== 'menu') return
    this.kaiju.setStageAnchor(-2.4, 11.6)
    this.kaiju.encounter.enter('idle')
    this.emitHud()
  }

  public previewNextForm() {
    if (!this.heroProfile.forms) return
    this.heroFormIndex = (this.heroFormIndex + 1) % this.heroProfile.forms.length
    const form = this.activeForm!
    this.applyHeroForm()
    this.hero.triggerAction('pose-intro', 0.7)
    const pos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, -0.6))
    this.effects.spawnBurst(pos, form.accentColor, 20, 20, 1.2)
    this.effects.spawnImpactRing(pos, form.accentColor, 6.2)
    this.audio.playTransform('type')
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
    this.deflectNearbyFireballs(6.5)

    this.audio.playTransform('type')
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

  /** 手动立即触发/跳过变身仪式（或按空格/点击按钮直接变身） */
  public triggerManualTransform() {
    if (this.phase !== 'transform' || this.transformBurstPlayed) return
    this.completeTransformBurst()
  }

  public setManualSpread(active: boolean) {
    this.manualSpreadHeld = active
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
    this.manualSpreadHeld = false
    this.wasGuarding = false
    this.guardStartedAt = -Infinity
    this.gestureLean = 0
    this.gestureGuard = false
    this.gestureBeamCharge = 0
    this.gestureBeamHolding = false
    this.gestureDiscCharge = 0
    this.gestureSpreading = false
    this.gestureStrugglePower = 0
    this.beamCooldown = 0
    this.discCooldown = 0
    this.punchCooldown = 0
    this.kickCooldown = 0
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.beamClashProgress = 0.5
    this.applyHeroForm()
    this.hero.resetPose()
    this.audio.setDangerAlarm(false)

    // 先预载首波战场与怪兽，然后进入「宇宙星海体感变身仪式」（复刻视频 1 00:01-00:02）
    const spec = MONSTER_WAVES[this.waveIndex]!
    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(this.waveIndex)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed) return

    this.beginTransformPhase()
  }

  private beginTransformPhase() {
    this.phase = 'transform'
    this.transformProgress = 0
    this.transformBurstPlayed = false
    this.transformHoldAfterTrigger = 0
    this.loadingProgress = 100
    this.kaiju.root.visible = false
    this.arena.setCosmicMode(true)
    this.hero.resetPose()
    this.hero.setStageBaseZ(12.2, true)
    this.hero.triggerAction('transform', 6.0)
    this.audio.playTransform('open')
    this.emitHud()
  }

  private completeTransformBurst() {
    if (this.transformBurstPlayed) return
    this.transformBurstPlayed = true
    this.transformProgress = 1
    this.transformHoldAfterTrigger = 0.95
    this.hero.triggerAction('transform', 1.2)
    this.audio.playTransform('rise')
    this.addTrauma(0.55)
    this.fovKick = -5.0
    const burstPos = new THREE.Vector3(0, 10.5, 12.0)
    this.effects.spawnBurst(burstPos, 0xfacc15, 42, 34, 1.55)
    this.effects.spawnEnergyShockSphere(burstPos, this.heroProfile.accentColor, 9.5)
    this.effects.spawnImpactRing(burstPos, 0xffffff, 14)
    this.effects.spawnHitFlash(burstPos, 0xffffff, 2.5)
    this.showBanner('bannerTransform', 1.1)
    this.emitHud()
  }

  private async loadWave(index: number, skipReloadIfSame = false): Promise<void> {
    const spec = MONSTER_WAVES[index]!
    this.audio.setMonster(spec.id)
    this.feetTracked = false
    this.jump.reset()
    this.punchChain = 0
    this.comboStep = 0
    this.chainTimeLeft = 0
    this.waveIndex = index
    this.monsterMaxHp = spec.maxHp
    this.monsterHp = spec.maxHp
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.effects.clearAllDynamic()

    // 重置五幕导演进度
    this.battleStage = 'melee'
    this.stageTimer = 0
    this.rangedTriggered = false
    this.grappleTriggered = false
    this.finisherTriggered = false
    this.rangedFireballTimer = 1.4
    this.grappleProgress = 0.48
    this.finisherSpreadProgress = 0
    this.finisherBeamFired = false
    this.finisherBeamWaitTimer = 0

    this.arena.setCosmicMode(false)

    if (!skipReloadIfSame) {
      this.phase = 'loading'
      this.loadingProgress = 75
      this.emitHud()
      await Promise.all([
        this.arena.setTheme(this.resolveThemeForWave(index)),
        this.kaiju.spawn(this.loader, spec),
      ])
      if (this.disposed) return
    }

    // 幕 1 近身贴脸肉搏距离落位（按怪兽真实包围盒前探深度自适应计算，5 大怪兽全员绝对零穿模！）
    const safeKaijuZ = Math.min(-2.4, -(this.kaiju.frontExtentZ - 0.5))
    this.hero.resetPose()
    this.hero.setStageBaseZ(8.8, true)
    this.hero.setLeanRange(4.8)
    this.kaiju.root.visible = true
    this.kaiju.setStageAnchor(safeKaijuZ, 8.8, null)
    this.kaiju.encounter.reset()

    this.loadingProgress = 100
    this.phase = 'intro'
    this.waveTransitionTimer = 1.1
    this.addTrauma(0.38)
    this.showBanner('bannerWaveStart', 1.35)
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.battleStage = 'melee'
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.arena.setCosmicMode(false)
    this.audio.setDangerAlarm(false)
    this.effects.clearAllDynamic()
    this.hero.resetPose()
    this.hero.setStageBaseZ(11.6, true)
    this.hero.setLeanRange(5.5)
    this.hero.triggerAction('pose-intro', 0.8)
    this.kaiju.root.visible = true
    this.kaiju.setStageAnchor(-2.4, 11.6)
    this.kaiju.encounter.directorLocked = false
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
    hands?: HandLandmarksInput | null,
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
      hands,
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
    this.gestureSpreading = snap.isSpreading
    this.gestureStrugglePower = snap.strugglePower
    this.gestureTransformProgress = snap.transformProgress
    this.gestureHintKey =
      !physicalKick && snap.hintKey === 'hintKick' ? 'hintReady' : snap.hintKey
    if (snap.livePose && !fullBody) snap.livePose.coverage = 'upper'

    this.hero.setLiveBodyPose(snap.livePose, now)

    // 幕 0：体感举手变身（复刻视频 1 00:01-00:02）
    if (this.phase === 'transform') {
      if (!this.transformBurstPlayed) {
        this.transformProgress = Math.max(this.transformProgress, snap.transformProgress)
        if (snap.transformTrigger || this.transformProgress >= 0.99) {
          this.completeTransformBurst()
        }
      }
      return
    }

    if (this.phase !== 'fighting') return

    // 幕 3：近身角力 QTE — 挥拳/踢腿或疯狂摆臂全部转化为推力！
    if (this.battleStage === 'grapple') {
      if (snap.punch || physicalKick) {
        this.boostGrapple(0.085)
      }
      return
    }

    // 幕 4A / 4B：二段必杀光线终结技演出
    if (this.battleStage === 'finisher-spread') {
      if (snap.spreadProgress >= 0.85) {
        this.finisherSpreadProgress = 1
      }
      return
    }
    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired && (snap.beamTrigger || snap.beamHolding || snap.beamCharge > 0.16 || snap.punch)) {
        this.fireFinisherSuperBeam()
      }
      return
    }

    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') {
      return
    }

    // 远程大步侧闪时触发炫酷滑步动作
    if (
      this.battleStage === 'ranged' &&
      Math.abs(snap.lateralVelocity) > 2.35 &&
      this.elapsedTime - this.lastDodgeTriggerAt > 0.42
    ) {
      this.lastDodgeTriggerAt = this.elapsedTime
      this.hero.triggerAction(snap.lateralVelocity < 0 ? 'dodge-left' : 'dodge-right', 0.3)
    }

    // 对波期间
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
    if (
      this.phase === 'fighting' &&
      this.battleStage === 'ranged' &&
      dir !== 0 &&
      dir !== this.manualLean &&
      this.elapsedTime - this.lastDodgeTriggerAt > 0.32
    ) {
      this.lastDodgeTriggerAt = this.elapsedTime
      this.hero.triggerAction(dir < 0 ? 'dodge-left' : 'dodge-right', 0.28)
    }
    this.manualLean = dir
  }

  public setManualGuard(active: boolean) {
    if (active && !this.manualGuard) {
      this.guardStartedAt = this.elapsedTime
    }
    this.manualGuard = active
  }

  public triggerManualPunch(side: 'left' | 'right') {
    if (this.phase === 'transform') {
      this.triggerManualTransform()
      return
    }
    if (this.phase !== 'fighting') return
    if (this.battleStage === 'grapple') {
      this.boostGrapple(0.11)
      return
    }
    if (this.battleStage === 'finisher-spread') {
      this.finisherSpreadProgress = Math.min(1, this.finisherSpreadProgress + 0.55)
      return
    }
    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired) this.fireFinisherSuperBeam()
      return
    }
    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.13)
      return
    }
    this.executePunch(side)
  }

  public triggerManualKick(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.battleStage === 'grapple') {
      this.boostGrapple(0.12)
      return
    }
    if (this.battleStage === 'finisher-spread') {
      this.finisherSpreadProgress = Math.min(1, this.finisherSpreadProgress + 0.55)
      return
    }
    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired) this.fireFinisherSuperBeam()
      return
    }
    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.15)
      return
    }
    this.executeKick(side)
  }

  public triggerManualDisc(side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.battleStage === 'grapple') {
      this.boostGrapple(0.11)
      return
    }
    if (this.battleStage === 'finisher-spread' || this.battleStage === 'finisher-beam') return
    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.15)
      return
    }
    this.executeDisc(side)
  }

  public triggerManualBeam() {
    if (this.phase === 'transform') {
      this.triggerManualTransform()
      return
    }
    if (this.phase !== 'fighting') return
    if (this.battleStage === 'grapple') {
      this.boostGrapple(0.12)
      return
    }
    if (this.battleStage === 'finisher-spread') {
      this.finisherSpreadProgress = Math.min(1, this.finisherSpreadProgress + 0.58)
      return
    }
    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired) this.fireFinisherSuperBeam()
      return
    }
    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') return
    if (this.beamClashActive) {
      this.boostBeamClash(0.16)
      return
    }
    this.executeBeam()
  }

  /** 挥拳/飞踢/光轮正面弹反击碎逼近的怪兽火球 */
  private deflectNearbyFireballs(reachZ = 6.2): boolean {
    let deflected = false
    const kaijuCenter = this.kaiju.getTargetCenter()
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      const proj = this.effects.projectiles[i]!
      if (proj.fromHero || proj.hitTriggered || proj.kind !== 'kaiju-fireball') continue
      const dz = this.hero.baseZ - proj.pos.z
      const dx = Math.abs(this.hero.currentX - proj.pos.x)
      if (dz >= -1.2 && dz <= reachZ && dx <= 4.6) {
        const hitPos = proj.pos.clone()
        this.effects.removeProjectileAt(i)
        this.effects.spawnBurst(hitPos, 0xfacc15, 22, 26, 1.25)
        this.effects.spawnImpactRing(hitPos, 0xfef08a, 6.4)
        this.effects.spawnHitFlash(hitPos, 0xffffff, 1.35)
        this.effects.spawnPalmBolt(
          hitPos,
          kaijuCenter,
          Math.round(46 * this.totalDamageMul),
          'right',
        )
        this.audio.playDeflect()
        this.gainEnergy(18)
        this.score += 320
        this.addHitStop(0.05)
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
    if (this.effects.isHeroBeamActive() || this.punchCooldown > 0) return

    // 幕 2 远程阶段：推掌连发蓝白奥特光弹（带清晰特摄节拍间隔）
    if (this.battleStage === 'ranged') {
      this.punchCooldown = RANGED_PALM_COOLDOWN
      this.hero.triggerAction(side === 'left' ? 'palm-left' : 'palm-right', 0.32)
      if (this.deflectNearbyFireballs(6.8)) {
        this.emitHud()
        return
      }
      const origin = this.hero.getFistOrigin(side)
      const target = this.kaiju.getTargetCenter()
      const dmg = Math.round(30 * this.totalDamageMul)
      this.effects.spawnPalmBolt(origin, target, dmg, side)
      this.effects.spawnBurst(origin, this.heroProfile.beamColor, 8, 15, 0.7)
      this.audio.playPalmShot()
      this.emitHud()
      return
    }

    // 幕 1 近战贴脸肉搏：5 段沉稳有力特摄武术连招 + 烈焰/电光弧形刀光斩击
    this.punchCooldown = MELEE_PUNCH_COOLDOWN
    this.punchChain = this.chainTimeLeft > 0 && this.lastPunchSide !== side ? this.punchChain + 1 : 1
    const isFifthCombo = this.comboStep === 4
    const action = MELEE_COMBO_ACTIONS[this.comboStep]!
    const slashStyle = MELEE_SLASH_STYLES[this.comboStep]!
    this.comboStep = (this.comboStep + 1) % MELEE_COMBO_ACTIONS.length
    const finisher = isFifthCombo || this.punchChain >= 3
    if (this.punchChain >= 3) this.punchChain = 3
    this.lastPunchSide = side
    this.chainTimeLeft = finisher ? 0 : 1.85

    this.hero.triggerAction(action, isFifthCombo ? 0.56 : finisher ? 0.46 : 0.38)
    if (finisher) this.fovKick = -3.0

    // 在奥特曼拳脚前方即时挥出红金/青蓝弧形刀光带
    const slashCenter = new THREE.Vector3(
      this.hero.currentX + (side === 'left' ? -0.6 : 0.6),
      isFifthCombo ? 9.8 : 9.2,
      this.hero.root.position.z - 3.6,
    )
    this.effects.spawnMeleeSlash(
      slashCenter,
      slashStyle.color,
      slashStyle.euler,
      isFifthCombo ? 1.45 : 1.15,
      slashStyle.spin,
    )

    if (this.deflectNearbyFireballs(6.2) && !finisher) {
      this.emitHud()
      return
    }

    const origin = isFifthCombo ? this.hero.getFootOrigin('right') : this.hero.getFistOrigin(side)
    const target = this.kaiju.getTargetCenter()
    const damage = Math.round((isFifthCombo ? 58 : finisher ? 46 : 28) * this.totalDamageMul)
    this.effects.spawnPunchWave(origin, target, damage, side, finisher)
    this.effects.spawnBurst(origin, slashStyle.color, 9, 16, 0.72)
    this.audio.playSwing(side, isFifthCombo)
    if (finisher) this.punchChain = 0
    this.emitHud()
  }

  private executeKick(side: 'left' | 'right', jumping = false) {
    if (this.effects.isHeroBeamActive() || this.kickCooldown > 0) return
    this.kickCooldown = KICK_MIN_COOLDOWN
    const action = jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right'
    this.hero.triggerAction(action, jumping ? 0.58 : 0.48)
    this.fovKick = jumping ? -3.6 : -2.6
    this.deflectNearbyFireballs(6.4)

    const slashCenter = new THREE.Vector3(
      this.hero.currentX,
      9.8,
      this.hero.root.position.z - 3.8,
    )
    this.effects.spawnMeleeSlash(slashCenter, 0xf97316, [1.18, 0.15, 0], 1.5, -1.6)

    const origin = this.hero.getFootOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnKickWave(
      origin,
      target,
      Math.round((jumping ? 64 : 48) * this.totalDamageMul),
    )
    this.effects.spawnBurst(origin, 0xf97316, 14, 20, 0.9)
    this.audio.playSwing(side, true)
    this.showBanner(jumping ? 'bannerJumpKick' : 'bannerKick', 0.85)
  }

  private executeDisc(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive() || this.discCooldown > 0) return
    const cdMul = this.activeForm?.discCooldownMul ?? 1
    this.discCooldown = DISC_MAX_COOLDOWN * cdMul
    this.hero.setDiscCharge(0, side)
    this.hero.triggerAction('disc', 0.48)
    this.deflectNearbyFireballs(6.8)

    const origin = this.hero.getDiscOrigin(side)
    const target = this.kaiju.getTargetCenter()
    this.effects.spawnUltraDisc(origin, target, Math.round(74 * this.totalDamageMul))
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

    const fight = this.kaiju.encounter
    const spec = MONSTER_WAVES[this.waveIndex]!
    if (
      fight.attack === 'dark-beam' &&
      ((fight.state === 'windup' && fight.time >= 0.25) || fight.state === 'attack')
    ) {
      this.startBeamClash(isSuper, spec.accentColor)
      return
    }

    const dur = isSuper ? 1.8 : 1.25
    this.hero.triggerAction('beam', dur)
    this.effects.startHeroBeam(isSuper, dur)
    this.audio.playBeam(isSuper)
    this.addTrauma(isSuper ? 0.65 : 0.42)
    this.fovKick = isSuper ? -4.5 : -3.0
    this.beamDamageTicksRemaining = isSuper ? 5 : 4
    this.beamDamagePerTick = Math.round((isSuper ? 38 : 26) * this.totalDamageMul)
    this.beamTickTimer = 0.18
    this.showBanner(
      isSuper
        ? `bannerSuperBeam${this.heroProfile.bannerKey}`
        : `bannerBeam${this.heroProfile.bannerKey}`,
      dur,
    )
    this.emitHud()
  }

  // ---- 五幕电影式阶段切换导演 ----

  /** 进入幕 2 过场：怪兽怒吼退入远端火海，镜头切英雄正面帅气特写，再拉至正后方躲火球走廊 */
  private beginRangedTransition() {
    this.rangedTriggered = true
    this.battleStage = 'transition-ranged'
    this.stageTimer = 0
    this.effects.clearAllDynamic()
    this.kaiju.encounter.directorLocked = true
    this.kaiju.encounter.enter('roaring')
    this.kaiju.setStageAnchor(-13.8, 14.5, 0)
    this.hero.setStageBaseZ(14.5, false)
    this.hero.setLeanRange(8.2)
    this.hero.triggerAction('cinematic-taunt', 1.35)
    this.audio.playRoar()
    this.addTrauma(0.55)
    this.showBanner('bannerStageRanged', 1.55)
    this.emitHud()
  }

  /** 进入幕 3：侧面超近景角力推力 QTE（精确拉开巨人前倾间距，迪迦居左、怪兽居右正面双掌相抵！） */
  private beginGrappleStage() {
    this.grappleTriggered = true
    this.battleStage = 'grapple'
    this.stageTimer = 0
    this.grappleProgress = 0.45
    this.grappleTimeLeft = 6.8
    this.effects.clearAllDynamic()
    // 按怪兽真实无截断前探距离动态落位：奥特曼在 +7.0（双掌伸至约 +4.2），怪兽最前沿精准停在 +3.2，中间 1m 火花对撞零穿模！
    const heroGrappleZ = 7.0
    const kaijuGrappleZ = heroGrappleZ - (this.kaiju.frontExtentZ + 4.4)
    const midZ = (heroGrappleZ + kaijuGrappleZ) * 0.5 + 1.2
    this.hero.currentX = 0
    this.hero.setLeanRange(0)
    this.hero.setLean(0)
    this.hero.setStageBaseZ(heroGrappleZ, true)
    this.hero.triggerAction('grapple', 9.0)
    this.kaiju.encounter.directorLocked = true
    this.kaiju.encounter.enter('grapple')
    this.kaiju.snapToPosition(0, kaijuGrappleZ)
    // 瞬切净空大道侧面全景特写（严格控制在 x <= 23.2 安全净空大道内，绝不穿入东侧高楼！）
    const portrait = THREE.MathUtils.clamp((0.92 - this.viewportAspect) / 0.46, 0, 1)
    this.cameraAnchor.set(
      THREE.MathUtils.lerp(23.0, 21.4, portrait),
      9.6 + portrait * 2.4,
      midZ + portrait * 9.5,
    )
    this.lookAnchor.set(0, 8.5 - portrait * 0.7, midZ)
    this.audio.playRoar()
    this.addTrauma(0.48)
    this.fovKick = -2.6
    this.showBanner('bannerStageGrapple', 1.5)
    this.emitHud()
  }

  private boostGrapple(delta: number) {
    if (this.battleStage !== 'grapple') return
    this.grappleProgress = Math.min(1, this.grappleProgress + delta)
    this.addTrauma(0.14)
    const clashZ = this.hero.root.position.z - 2.6
    const clashPos = new THREE.Vector3(0, 9.4, clashZ)
    this.effects.spawnBurst(clashPos, 0x38e8ff, 8, 20, 0.9)
    if (this.grappleSfxCooldown <= 0) {
      this.audio.playGrapplePush()
      this.grappleSfxCooldown = 0.18
    }
    this.emitHud()
  }

  private finishGrapple(won: boolean) {
    this.battleStage = 'grapple-finish'
    this.stageTimer = 0
    const clashPos = new THREE.Vector3(0, 9.2, this.hero.root.position.z - 2.6)
    if (won) {
      this.hero.triggerAction('grapple-throw', 0.85)
      this.kaiju.encounter.enter('thrown')
      this.kaiju.setStageAnchor(-13.0, 8.8, 0)
      this.effects.spawnBurst(clashPos, 0xfacc15, 36, 32, 1.45)
      this.effects.spawnEnergyShockSphere(clashPos, 0x38e8ff, 8.2)
      this.effects.spawnImpactRing(clashPos, 0xfef08a, 11)
      this.audio.playHeavyImpact()
      this.audio.playExplosion()
      this.addHitStop(0.085)
      this.addTrauma(0.75)
      this.fovKick = -4.5
      this.gainEnergy(35)
      this.score += 950
      this.combo += 5
      this.maxCombo = Math.max(this.maxCombo, this.combo)
      this.comboResetTimer = 4.2
      // 过肩摔造成巨额伤害并将怪兽压入残血处决线附近
      const floorHp = Math.max(1, Math.round(this.monsterMaxHp * 0.16))
      const throwDmg = Math.max(95, this.monsterHp - floorHp)
      this.monsterHp = Math.max(1, this.monsterHp - throwDmg)
      this.spawnFloatingAtWorld(
        this.kaiju.getTargetCenter(),
        `-${throwDmg}!`,
        '#fef08a',
        1.45,
        'crit',
      )
      this.showBanner('bannerGrappleWin', 1.4)
    } else {
      this.hero.triggerAction('hit', 0.5)
      this.kaiju.encounter.enter('recovering')
      this.kaiju.setStageAnchor(-2.2, 7.0, null)
      this.hero.setStageBaseZ(7.0, false)
      this.hero.setLeanRange(5.2)
      this.heroHp = Math.max(15, this.heroHp - 12)
      this.audio.playHeroHurt()
      this.addTrauma(0.45)
    }
    this.emitHud()
  }

  /** 进入幕 4A：残血终结技——奥特曼正面特写双臂展翼七彩棱镜聚能（怪兽稳退远端，零遮挡特写！） */
  private beginFinisherSpread() {
    this.finisherTriggered = true
    this.battleStage = 'finisher-spread'
    this.stageTimer = 0
    this.finisherSpreadProgress = 0
    this.finisherBeamFired = false
    this.effects.clearAllDynamic()
    this.hero.currentX = 0
    this.hero.setLeanRange(0)
    this.hero.setLean(0)
    this.hero.setStageBaseZ(12.0, true)
    this.hero.triggerAction('beam-spread', 12)
    this.kaiju.encounter.directorLocked = true
    this.kaiju.encounter.enter('stunned')
    // 怪兽落位在 Z = -26.0（兼容手机竖屏相机后拉至 Z = -11.6，始终在相机背后十余米零遮挡！）
    const portrait = THREE.MathUtils.clamp((0.92 - this.viewportAspect) / 0.46, 0, 1)
    this.kaiju.snapToPosition(0, -26.0)
    this.cameraAnchor.set(0, THREE.MathUtils.lerp(10.15, 9.6, portrait), 0.6 - portrait * 12.2)
    this.lookAnchor.set(0, THREE.MathUtils.lerp(9.85, 8.8, portrait), 12.0)
    this.audio.playRainbowCharge()
    this.showBanner('bannerFinisherCharge', 1.6)
    this.emitHud()
  }

  /** 进入幕 4B：高空斜俯超级光线准备就绪 */
  private enterFinisherBeamStage() {
    this.battleStage = 'finisher-beam'
    this.stageTimer = 0
    this.finisherBeamFired = false
    this.finisherBeamWaitTimer = 0
    this.finisherTickTimer = 0
    this.effects.updateRainbowGather(false, new THREE.Vector3(), 0, this.elapsedTime)
    const burstPos = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.6, 0))
    this.effects.spawnBurst(burstPos, 0xfacc15, 32, 28, 1.35)
    this.effects.spawnImpactRing(burstPos, 0x38e8ff, 10)
    // 电影剪辑瞬切高空宏阔斜俯大片机位（迪迦稳立左下黄金点、光线斜穿全场轰爆右上怪兽！）
    this.cameraAnchor.set(18.5, 18.2, 22.8)
    this.lookAnchor.set(0, 8.4, -2.5)
    this.audio.playTransform()
    this.addTrauma(0.35)
    this.showBanner('bannerFinisherFire', 1.8)
    this.emitHud()
  }

  /** 发射终结级闪电超级光线，2.1 秒内轰爆怪兽（复刻视频 1 00:07-00:09） */
  private fireFinisherSuperBeam() {
    if (this.finisherBeamFired) return
    this.finisherBeamFired = true
    this.stageTimer = 0
    this.hero.triggerAction('beam', 2.4)
    this.kaiju.encounter.enter('finisher-hit')
    this.effects.startHeroBeam(true, 2.3)
    this.audio.playBeam(true)
    this.addTrauma(0.75)
    this.fovKick = -5.2
    this.showBanner(`bannerSuperBeam${this.heroProfile.bannerKey}`, 2.2)
    this.emitHud()
  }

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
      this.effects.spawnEnergyShockSphere(center, 0x38e8ff, 7.2)
      this.effects.spawnImpactRing(center, 0xfacc15, 12)
      this.effects.spawnHitFlash(center, 0xffffff, 2.2)
      this.audio.playHeavyImpact()
      this.audio.playExplosion()
      this.kaiju.encounter.enter('staggered')
      this.gainEnergy(25)
      this.score += 650
      this.showBanner('bannerClashWin', 1.25)
      this.applyDamageToMonster(
        Math.round(138 * this.totalDamageMul),
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
    this.shakeTrauma = Math.min(1.15, this.shakeTrauma + amount)
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
    allowLethal = false,
  ) {
    if (this.phase !== 'fighting' || this.monsterHp <= 0) return

    const id = MONSTER_WAVES[this.waveIndex]!.id
    amount = this.kaiju.encounter.receiveHit(
      amount,
      impact,
      id === 'zetton' || id === 'gomora-mecha',
    )
    if (amount <= 0) return

    // 在终结光线演出未触发前，保留 1 点血以丝滑切入燃爆的「二段必杀光线处决」环节！
    const minRemain = !allowLethal && !this.finisherTriggered ? 1 : 0
    this.monsterHp = Math.max(minRemain, this.monsterHp - amount)
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.comboResetTimer = 3.8
    this.score += amount * (10 + Math.min(25, this.combo))

    const hitPos = this.kaiju.getTargetCenter()
    if (punchSide) hitPos.x += punchSide === 'left' ? -1.4 : 1.4
    this.kaiju.triggerHitFlash(isCritical ? 1 : 0.78, punchSide)
    this.effects.spawnBurst(
      hitPos,
      isCritical ? 0xfacc15 : this.heroProfile.beamColor,
      isCritical ? 28 : 16,
      isCritical ? 30 : 22,
      isCritical ? 1.32 : 0.98,
    )

    if (impact === 'heavy') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime)
      this.addHitStop(0.088)
      this.addTrauma(0.45)
      this.fovKick = -3.0
      this.effects.spawnEnergyShockSphere(hitPos, 0x38bdf8, 5.4)
      this.effects.spawnImpactRing(hitPos, 0xfef08a, 8.0)
      this.effects.spawnHitFlash(hitPos, isCritical ? 0xfef08a : 0xffffff, 1.55)
    } else if (impact === 'light') {
      this.addHitStop(0.05)
      this.addTrauma(0.24)
      this.fovKick = -1.5
      this.effects.spawnEnergyShockSphere(hitPos, 0x38bdf8, 3.6)
      this.effects.spawnImpactRing(hitPos, this.heroProfile.burstColor, 5.0)
      this.effects.spawnHitFlash(hitPos, 0xffffff, 1.08)
    } else {
      this.addTrauma(0.14)
      this.effects.spawnHitFlash(hitPos, this.heroProfile.beamColor, 1.05)
    }

    this.spawnFloatingAtWorld(
      hitPos.clone().add(new THREE.Vector3(0, 1.8, 0)),
      `-${amount}${isCritical ? '!' : ''}`,
      color,
      isCritical ? 1.35 : 1.05,
      isCritical ? 'crit' : 'normal',
    )

    // 根据怪兽血量阈值丝滑触发五幕电影式转场
    const hpRatio = this.monsterHp / this.monsterMaxHp
    if (this.monsterHp <= 0) {
      this.onMonsterDefeated()
    } else if (!this.rangedTriggered && this.battleStage === 'melee' && hpRatio <= 0.72) {
      this.beginRangedTransition()
    } else if (!this.grappleTriggered && this.battleStage === 'ranged' && hpRatio <= 0.4) {
      this.beginGrappleStage()
    } else if (
      !this.finisherTriggered &&
      this.battleStage !== 'grapple' &&
      this.battleStage !== 'grapple-finish' &&
      hpRatio <= 0.18
    ) {
      this.beginFinisherSpread()
    }
    this.emitHud()
  }

  private onMonsterDefeated() {
    this.defeatedCount += 1
    this.score += 1800 + this.waveIndex * 700
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.effects.setBeamClash(false, 0.5)
    this.effects.stopHeroBeam()
    this.kaiju.encounter.directorLocked = false
    this.kaiju.encounter.enter('dying')
    this.audio.playExplosion()
    this.addHitStop(0.14)
    this.addTrauma(0.98)
    this.fovKick = -5.0

    const center = this.kaiju.getTargetCenter()
    this.effects.spawnEnergyShockSphere(center, 0xff5a2c, 11.5)
    this.effects.spawnImpactRing(center, 0xffd28a, 15)
    this.effects.spawnBurst(center, 0xff6b2b, 48, 38, 1.8)
    this.effects.spawnBurst(center.clone().add(new THREE.Vector3(0, 3, 1)), 0xfacc15, 34, 30, 1.5)
    this.effects.spawnHitFlash(center, 0xffffff, 2.8)

    if (this.waveIndex + 1 >= MONSTER_WAVES.length) {
      this.phase = 'victory'
      this.audio.setDangerAlarm(false)
      this.kaiju.root.visible = false
      this.arena.setCosmicMode(true)
      this.hero.triggerAction('victory', 10)
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
    if (
      this.battleStage === 'transition-ranged' ||
      this.battleStage === 'grapple-finish' ||
      this.battleStage === 'finisher-spread' ||
      this.battleStage === 'finisher-beam'
    ) {
      return
    }

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

    // 远程大步闪避判定（火球偏离英雄横向超过 3.1m 即判定完美闪避！）
    if (attack === 'fireball' && Math.abs(this.hero.currentX - attackX) > 3.05) {
      this.gainEnergy(16)
      this.score += 260
      this.audio.playDodge()
      this.spawnFloatingAtWorld(
        new THREE.Vector3(this.hero.currentX, 14.2, this.hero.baseZ),
        'DODGE!',
        '#4ade80',
        1.22,
        'dodge',
      )
      this.emitHud()
      return
    }

    const isGuarding = this.isHeroGuarding()
    if (isGuarding) {
      const isJustGuard = this.elapsedTime - this.guardStartedAt <= 0.85
      this.audio.playGuardBlock()
      this.effects.triggerShieldBlockFlash()
      this.effects.spawnBurst(
        new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 2.8),
        isJustGuard ? 0xfef08a : 0x7dd3fc,
        isJustGuard ? 24 : 14,
        24,
        1.15,
      )
      this.effects.spawnImpactRing(
        new THREE.Vector3(this.hero.currentX, 9.0, this.hero.baseZ - 2.8),
        isJustGuard ? 0xfef08a : 0x38bdf8,
        isJustGuard ? 7.2 : 5.2,
      )
      this.addHitStop(isJustGuard ? 0.05 : 0.03)
      this.addTrauma(isJustGuard ? 0.34 : 0.2)

      if (isJustGuard) {
        if (attack === 'melee' && this.kaiju.encounter.state === 'attack') {
          this.kaiju.encounter.enter('staggered')
        }
        this.perfectGuards += 1
        this.gainEnergy(28)
        this.score += 420
        this.spawnFloatingAtWorld(
          new THREE.Vector3(this.hero.currentX, 14.6, this.hero.baseZ),
          'PERFECT GUARD!',
          '#38bdf8',
          1.26,
          'guard',
        )
        this.showBanner('bannerPerfectGuard', 0.95)
      } else {
        const chipDamage = Math.max(2, Math.round(damage * 0.18))
        this.heroHp = Math.max(1, this.heroHp - chipDamage)
        this.gainEnergy(12)
        this.score += 140
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
    this.hero.triggerAction('hit', 0.4)
    this.audio.playHeroHurt()
    this.addHitStop(0.07)
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
    this.composer.render()
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    if (this.beamCooldown > 0) this.beamCooldown = Math.max(0, this.beamCooldown - dt)
    if (this.discCooldown > 0) this.discCooldown = Math.max(0, this.discCooldown - dt)
    if (this.punchCooldown > 0) this.punchCooldown = Math.max(0, this.punchCooldown - rawDt)
    if (this.kickCooldown > 0) this.kickCooldown = Math.max(0, this.kickCooldown - rawDt)
    if (this.grappleSfxCooldown > 0) this.grappleSfxCooldown = Math.max(0, this.grappleSfxCooldown - rawDt)
    if (this.rainbowSfxCooldown > 0) this.rainbowSfxCooldown = Math.max(0, this.rainbowSfxCooldown - rawDt)
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

    const canMoveLateral =
      this.phase === 'fighting' &&
      (this.battleStage === 'melee' || this.battleStage === 'ranged')
    const combinedLean = canMoveLateral
      ? this.manualLean !== 0
        ? this.manualLean
        : this.controlMode === 'camera'
          ? this.gestureLean
          : 0
      : 0
    const guarding = canMoveLateral && this.isHeroGuarding()
    if (guarding && !this.wasGuarding) {
      this.guardStartedAt = this.elapsedTime
    }
    this.wasGuarding = guarding

    this.hero.setLean(combinedLean)
    this.hero.setGuard(guarding)
    this.hero.setBeamCharge(
      this.controlMode === 'camera' && canMoveLateral ? this.gestureBeamCharge : 0,
      this.gestureBeamArmSide,
    )
    this.hero.setDiscCharge(
      this.controlMode === 'camera' && canMoveLateral ? this.gestureDiscCharge : 0,
      this.gestureDiscSide,
    )

    const dangerTimer = this.phase === 'fighting' && this.heroHp <= this.heroMaxHp * 0.3
    // 先更新怪兽世界变换，再向英雄注入基于怪兽真实前表面的实时防穿模硬屏障 Z！
    if (this.phase !== 'fighting') this.advanceEncounter(dt, false)
    this.kaiju.update(dt, this.elapsedTime, this.hero.currentX)
    const enforceCollision =
      this.phase === 'fighting' &&
      this.kaiju.root.visible &&
      this.kaiju.encounter.state !== 'dying' &&
      this.kaiju.encounter.state !== 'thrown'
    this.hero.setMinSafeWorldZ(
      enforceCollision ? this.kaiju.getFrontSurfaceZ() + 2.85 : -Infinity,
    )
    this.hero.update(dt, this.elapsedTime, dangerTimer, nowMs, rawDt)
    this.arena.update(
      this.elapsedTime,
      this.hero.root.position,
      this.kaiju.root.position,
      this.kaiju.root.visible,
    )

    // 幕 0：宇宙星空变身仪式更新
    if (this.phase === 'transform') {
      if (!this.transformBurstPlayed) {
        if (this.controlMode === 'keyboard') {
          this.transformProgress = Math.min(1, this.transformProgress + rawDt * 0.72)
          if (this.transformProgress >= 1) this.completeTransformBurst()
        }
        // 高举手时英雄掌心绽放聚能光环
        const handPos = this.hero.getFistOrigin('right')
        this.effects.updateRainbowGather(
          this.transformProgress > 0.08,
          handPos,
          this.transformProgress,
          this.elapsedTime,
        )
      } else {
        this.effects.updateRainbowGather(false, new THREE.Vector3(), 0, this.elapsedTime)
        this.transformHoldAfterTrigger -= rawDt
        if (this.transformHoldAfterTrigger <= 0) {
          void this.loadWave(this.waveIndex, true)
        }
      }
    } else if (this.phase === 'intro') {
      this.waveTransitionTimer -= dt
      if (this.waveTransitionTimer <= 0) {
        this.phase = 'fighting'
        this.emitHud()
      }
    } else if (this.phase === 'wave-clear') {
      this.waveTransitionTimer -= dt
      if (this.waveTransitionTimer <= 0) {
        this.heroHp = Math.min(this.heroMaxHp, this.heroHp + 40)
        if (this.heroHp > this.heroMaxHp * 0.3) {
          this.audio.setDangerAlarm(false)
        }
        void this.loadWave(this.waveIndex + 1, false)
      }
    } else if (this.phase === 'fighting') {
      this.stepCombat(dt, rawDt)
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
      this.controlMode === 'camera' && canMoveLateral ? this.gestureBeamCharge : 0,
      beamSeg[0].clone().lerp(beamSeg[1], 0.55),
      this.controlMode === 'camera' && canMoveLateral ? this.gestureDiscCharge : 0,
      this.hero.getDiscOrigin(this.gestureDiscSide ?? 'right'),
      this.elapsedTime,
    )
    this.effects.updateTypeCharge(
      this.controlMode === 'camera' && canMoveLateral && this.heroProfile.forms
        ? this.gestureTypeCharge
        : 0,
      new THREE.Vector3(this.hero.currentX, 15.2, this.hero.root.position.z + 0.4),
      this.activeForm?.accentColor ?? 0xb388ff,
      this.elapsedTime,
    )

    // 展臂七彩棱镜聚能特效同步（中心置于英雄身后 +1.8m，确保七彩光芒环绕周身绝不遮糊面部与胸甲）
    if (this.phase !== 'transform') {
      const showRainbow = this.phase === 'fighting' && this.battleStage === 'finisher-spread'
      const backAuraCenter = this.hero.root.position.clone().add(new THREE.Vector3(0, 9.4, 1.8))
      this.effects.updateRainbowGather(
        showRainbow,
        backAuraCenter,
        this.finisherSpreadProgress,
        this.elapsedTime,
      )
    }

    const isWarning =
      this.phase === 'fighting' &&
      canMoveLateral &&
      fight.state === 'windup' &&
      !this.beamClashActive
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

    this.hudSyncAccumulator += rawDt
    if (this.hudSyncAccumulator >= 0.05) {
      this.hudSyncAccumulator = 0
      this.emitHud()
    }
  }

  private stepCombat(dt: number, rawDt: number) {
    this.stageTimer += rawDt

    // 1. 幕 2 过场特写演出 -> 自动进入远程火球对峙
    if (this.battleStage === 'transition-ranged') {
      if (this.stageTimer >= 1.55) {
        this.battleStage = 'ranged'
        this.stageTimer = 0
        this.rangedFireballTimer = 0.85
        this.kaiju.encounter.directorLocked = false
        this.kaiju.encounter.enter('idle')
        this.emitHud()
      }
      return
    }

    // 2. 幕 3：近身侧面角力推力 QTE（复刻视频 2 1:04-1:12）
    if (this.battleStage === 'grapple') {
      this.grappleTimeLeft -= rawDt
      const camPush =
        this.controlMode === 'camera' ? this.gestureStrugglePower * 0.72 : 0
      const kaijuResist = 0.19
      this.grappleProgress = THREE.MathUtils.clamp(
        this.grappleProgress + (camPush - kaijuResist) * rawDt,
        0.08,
        1.0,
      )
      if (camPush > 0.25 && this.grappleSfxCooldown <= 0) {
        this.audio.playGrapplePush()
        this.grappleSfxCooldown = 0.22
      }
      // 角力交锋处持续迸射能量火花（精确贴合双方双掌对抵点）
      if (Math.random() < 0.72) {
        this.effects.spawnBurst(
          new THREE.Vector3(0, 9.3, this.hero.root.position.z - 2.6),
          Math.random() > 0.5 ? 0x38e8ff : 0xff6b2b,
          2,
          18,
          0.95,
        )
      }
      this.addTrauma(0.05)

      if (this.grappleProgress >= 0.98) {
        this.finishGrapple(true)
      } else if (this.grappleTimeLeft <= 0) {
        this.finishGrapple(this.grappleProgress >= 0.42)
      }
      return
    }

    // 3. 角力收尾过肩摔 + 后空翻落地起身特写（复刻视频 2 1:12-1:18）
    if (this.battleStage === 'grapple-finish') {
      if (this.stageTimer >= 0.85 && this.hero.getAction() !== 'backflip-land') {
        this.hero.triggerAction('backflip-land', 1.2)
      }
      if (this.stageTimer >= 2.1) {
        if (this.monsterHp / this.monsterMaxHp <= 0.2) {
          this.beginFinisherSpread()
        } else {
          this.battleStage = 'melee'
          this.stageTimer = 0
          this.hero.setStageBaseZ(8.4, false)
          this.hero.setLeanRange(4.8)
          this.kaiju.setStageAnchor(-2.2, 8.4, null)
          this.kaiju.encounter.directorLocked = false
          this.kaiju.encounter.enter('staggered')
        }
        this.emitHud()
      }
      return
    }

    // 4. 幕 4A：双臂展翼七彩棱镜聚能（大幅提速：展臂/按住约 0.52s 聚满，自然保底约 1.7s 自动聚满，告别漫长举手等待）
    if (this.battleStage === 'finisher-spread') {
      const spreading =
        this.controlMode === 'camera' ? this.gestureSpreading : this.manualSpreadHeld
      const chargeSpeed = spreading ? 1.9 : 0.58
      this.finisherSpreadProgress = Math.min(1, this.finisherSpreadProgress + rawDt * chargeSpeed)
      if (spreading && this.rainbowSfxCooldown <= 0) {
        this.audio.playRainbowCharge()
        this.rainbowSfxCooldown = 0.55
      }
      if (this.finisherSpreadProgress >= 1) {
        this.enterFinisherBeamStage()
      }
      return
    }

    // 5. 幕 4B：高空斜俯超级光线绝杀
    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired) {
        this.finisherBeamWaitTimer += rawDt
        // 超过 2.2s 自动辅助激发，保证收尾节奏干脆爽快
        if (this.finisherBeamWaitTimer >= 2.2) {
          this.fireFinisherSuperBeam()
        }
      } else {
        this.addTrauma(0.14)
        this.finisherTickTimer -= rawDt
        if (this.finisherTickTimer <= 0) {
          this.finisherTickTimer = 0.28
          const hitPos = this.kaiju.getTargetCenter()
          this.spawnFloatingAtWorld(hitPos, `-${Math.round(95 * this.totalDamageMul)}!`, '#38e8ff', 1.38, 'crit')
        }
        if (this.stageTimer >= 2.15) {
          this.monsterHp = 0
          this.onMonsterDefeated()
        }
      }
      return
    }

    // 6. 宿命双光线对波结算循环
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

    // 7. 远程阶段专用高频三车道熔岩火球雨（复刻视频 2 0:46-1:03）
    if (this.battleStage === 'ranged') {
      this.rangedFireballTimer -= dt
      if (this.rangedFireballTimer <= 0 && this.kaiju.encounter.state !== 'windup') {
        const lanes = [-5.6, 0, 5.6]
        // 交替瞄准玩家当前所在车道与相邻车道，诱导玩家畅快左右大步横移！
        const targetLane =
          this.rangedLaneCursor % 2 === 0
            ? THREE.MathUtils.clamp(this.hero.currentX, -6.2, 6.2)
            : lanes[this.rangedLaneCursor % lanes.length]!
        this.rangedLaneCursor++
        this.kaiju.encounter.forceAttack('fireball', targetLane)
        this.audio.playWarning()
        this.rangedFireballTimer = 2.65
      }
    }

    // 8. 抛射物碰撞与空中消弹（若某发命中触发阶段切换并重置特效数组，则立刻中止剩余旧弹幕结算）
    const stageBefore = this.battleStage
    const kaijuCenter = this.kaiju.getTargetCenter()
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      if (this.phase !== 'fighting' || this.battleStage !== stageBefore) return
      const proj = this.effects.projectiles[i]
      if (!proj || proj.hitTriggered) continue

      if (proj.fromHero) {
        for (const other of this.effects.projectiles) {
          if (!other.fromHero && !other.hitTriggered && other.kind === 'kaiju-fireball') {
            if (proj.pos.distanceTo(other.pos) < 3.8) {
              other.hitTriggered = true
              this.effects.spawnBurst(other.pos, 0xfacc15, 18, 24, 1.15)
              this.effects.spawnImpactRing(other.pos, 0xfef08a, 5.6)
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
          } else if (proj.kind === 'palm-bolt') {
            this.gainEnergy(10)
            this.audio.playPunch(true)
            this.applyDamageToMonster(proj.damage, '#67e8f9', false, 'light', proj.punchSide)
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
    const allowed: MonsterAttackKind[] | undefined =
      this.battleStage === 'melee'
        ? ['melee', 'melee', 'fireball']
        : this.battleStage === 'ranged'
          ? ['fireball', 'fireball', 'dark-beam']
          : undefined
    const event: EncounterEvent | undefined = fight.advance(
      dt,
      fighting,
      this.monsterHp / this.monsterMaxHp,
      this.hero.currentX,
      spec,
      allowed,
      this.battleStage === 'ranged' ? 1.4 : 1.0,
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
        const fbSpeed = this.battleStage === 'ranged' ? 18.5 : 17.5
        this.effects.spawnKaijuFireball(
          this.kaiju.getAttackEmitOrigin(),
          new THREE.Vector3(fight.targetX, 8.8, this.hero.baseZ),
          spec.accentColor,
          spec.attackDamage,
          fbSpeed,
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

  /**
   * 悦动元气机电影级分镜运镜导演：
   * 每个阶段独立定制最震撼的特摄焦段与构图，并用指数阻尼无缝推拉运镜。
   */
  private updateCamera(dt: number) {
    const wideFactor = THREE.MathUtils.clamp((this.viewportAspect - 0.68) / 0.72, 0, 1)
    // 手机竖屏因子（aspect <= 0.92 时平滑增至 1）：按水平视宽等比后拉相机，杜绝角色/双臂/角力被左右切边
    const portraitFactor = THREE.MathUtils.clamp((0.92 - this.viewportAspect) / 0.46, 0, 1)
    const targetCam = new THREE.Vector3()
    const targetLook = new THREE.Vector3()
    let desiredBaseFov = 46

    if (this.phase === 'menu') {
      const sway = Math.sin(this.elapsedTime * 0.55) * 0.55
      const menuOffsetX = THREE.MathUtils.lerp(0.6, 6.2, wideFactor)
      targetCam.set(
        menuOffsetX + sway,
        THREE.MathUtils.lerp(9.6, 10.6, portraitFactor),
        THREE.MathUtils.lerp(28.8, 36.2, portraitFactor),
      )
      targetLook.set(
        THREE.MathUtils.lerp(-0.3, 0, portraitFactor),
        THREE.MathUtils.lerp(7.2, 5.2, portraitFactor),
        3.2,
      )
    } else if (this.phase === 'transform') {
      // 宇宙变身正面仰拍特写（竖屏略后拉确保高举双臂不裁顶）
      targetCam.set(
        Math.sin(this.elapsedTime * 0.8) * 1.1,
        THREE.MathUtils.lerp(8.8, 9.5, portraitFactor),
        THREE.MathUtils.lerp(27.6, 33.0, portraitFactor),
      )
      targetLook.set(0, THREE.MathUtils.lerp(8.2, 7.2, portraitFactor), 12.2)
      desiredBaseFov = 44
    } else if (this.phase === 'victory') {
      // 英雄合影构图（竖屏适度后拉并留出下方操作区）
      targetCam.set(
        THREE.MathUtils.lerp(0.4, 0, portraitFactor),
        THREE.MathUtils.lerp(8.6, 9.2, portraitFactor),
        THREE.MathUtils.lerp(26.8, 32.5, portraitFactor),
      )
      targetLook.set(
        THREE.MathUtils.lerp(0.4, 0, portraitFactor),
        THREE.MathUtils.lerp(8.0, 6.6, portraitFactor),
        12.2,
      )
      desiredBaseFov = 43
    } else if (this.battleStage === 'transition-ranged') {
      if (this.stageTimer < 1.05) {
        targetCam.set(
          this.hero.currentX + THREE.MathUtils.lerp(2.8, 1.4, portraitFactor),
          10.6,
          this.hero.root.position.z - THREE.MathUtils.lerp(8.2, 11.4, portraitFactor),
        )
        targetLook.set(this.hero.currentX, 9.8, this.hero.root.position.z)
        desiredBaseFov = 38
      } else {
        targetCam.set(
          0,
          THREE.MathUtils.lerp(15.2, 17.6, portraitFactor),
          THREE.MathUtils.lerp(29.8, 36.2, portraitFactor),
        )
        targetLook.set(0, 8.4, -8.5)
        desiredBaseFov = 50
      }
    } else if (this.battleStage === 'grapple') {
      // 净空大道侧面角力全景特写（严格锁在 x <= 23.2 大道净空内绝不穿楼；竖屏沿大道纵轴斜偏 + 抬升微俯，完整拍全双雄对推！）
      const sideDist = THREE.MathUtils.lerp(21.4, 23.2, wideFactor)
      const clashMidZ = (this.hero.root.position.z + this.kaiju.getFrontSurfaceZ()) * 0.5
      const jitter = Math.sin(this.elapsedTime * 22) * 0.14
      targetCam.set(sideDist, 9.6 + portraitFactor * 2.4 + jitter, clashMidZ + portraitFactor * 9.5)
      targetLook.set(0, THREE.MathUtils.lerp(8.5, 7.8, portraitFactor), clashMidZ)
      desiredBaseFov = 50 + portraitFactor * 6
    } else if (this.battleStage === 'grapple-finish') {
      if (this.stageTimer < 0.85) {
        targetCam.set(
          Math.min(22.5, 19.5 + portraitFactor * 2.5),
          10.6 + portraitFactor * 2.2,
          3.8 + portraitFactor * 7.5,
        )
        targetLook.set(0, 9.0, -5.5)
        desiredBaseFov = 49 + portraitFactor * 5
      } else {
        targetCam.set(
          this.hero.currentX + 1.6,
          9.5,
          this.hero.root.position.z - THREE.MathUtils.lerp(8.6, 13.5, portraitFactor),
        )
        targetLook.set(this.hero.currentX, 8.8, this.hero.root.position.z)
        desiredBaseFov = 39 + portraitFactor * 4
      }
    } else if (this.battleStage === 'finisher-spread') {
      // 奥特曼正中对称庄严大特写双臂展开七彩聚能（竖屏向 -Z 拉远 12.2m，完整入画整对展开双臂与十指！）
      const camZ =
        THREE.MathUtils.lerp(0.6, 2.1, this.finisherSpreadProgress) - portraitFactor * 12.2
      targetCam.set(0, THREE.MathUtils.lerp(10.15, 9.6, portraitFactor), camZ)
      targetLook.set(0, THREE.MathUtils.lerp(9.85, 8.8, portraitFactor), 12.0)
      desiredBaseFov = THREE.MathUtils.lerp(44, 52, portraitFactor)
    } else if (this.battleStage === 'finisher-beam') {
      // 高空宏阔斜俯大片机位（严格控制在大道安全净空内绝不撞楼，竖屏拉远确保左下迪迦与右上怪兽同框）
      const sideX = Math.min(22.2, THREE.MathUtils.lerp(14.5, 18.5, wideFactor) + portraitFactor * 4.5)
      targetCam.set(
        sideX,
        THREE.MathUtils.lerp(18.2, 22.8, portraitFactor),
        THREE.MathUtils.lerp(22.8, 31.2, portraitFactor),
      )
      targetLook.set(0, THREE.MathUtils.lerp(8.4, 7.4, portraitFactor), -2.5)
      desiredBaseFov = 49 + portraitFactor * 5
    } else if (this.beamClashActive) {
      const sideX = Math.min(22.2, THREE.MathUtils.lerp(9.5, 15.2, wideFactor) + portraitFactor * 6.5)
      targetCam.set(sideX, 10.2 + portraitFactor * 1.8, 9.2 + portraitFactor * 6.5)
      targetLook.set(0, 9.2, 1.5)
      desiredBaseFov = 48 + portraitFactor * 5
    } else if (this.effects.isHeroBeamActive()) {
      const sideSign = this.gestureBeamArmSide === 'left' ? -1 : 1
      const beamOffsetX = sideSign * THREE.MathUtils.lerp(4.2, 8.6, wideFactor)
      targetCam.set(
        this.hero.currentX * 0.45 + beamOffsetX,
        11.4 + portraitFactor * 1.4,
        this.hero.baseZ + THREE.MathUtils.lerp(8.6, 13.5, portraitFactor),
      )
      targetLook.set(this.kaiju.currentX * 0.45, 9.2, this.kaiju.currentZ + 2.5)
      desiredBaseFov = 48
    } else if (this.battleStage === 'ranged') {
      // 宏阔正后方街道走廊视角（竖屏后拉以完整覆盖左中右三车道火球轨迹）
      targetCam.set(
        this.hero.currentX * 0.34,
        THREE.MathUtils.lerp(15.2, 17.8, portraitFactor),
        THREE.MathUtils.lerp(30.2, 36.8, portraitFactor),
      )
      targetLook.set(
        this.hero.currentX * 0.2,
        THREE.MathUtils.lerp(8.2, 7.0, portraitFactor),
        -9.0,
      )
      desiredBaseFov = 50
    } else {
      // 贴身近战低机位斜后特摄仰拍（竖屏适度居中拉远，避免英雄和怪兽肩膀被竖屏裁边）
      const sideOffset = THREE.MathUtils.lerp(1.8, 5.8, wideFactor)
      targetCam.set(
        this.hero.currentX * 0.45 + sideOffset,
        THREE.MathUtils.lerp(9.8, 10.8, portraitFactor),
        THREE.MathUtils.lerp(22.0, 27.4, portraitFactor),
      )
      targetLook.set(
        this.hero.currentX * 0.25 - THREE.MathUtils.lerp(0.5, 0.1, portraitFactor),
        THREE.MathUtils.lerp(8.8, 7.4, portraitFactor),
        0.6,
      )
      desiredBaseFov = 46
    }

    const camRate =
      this.phase === 'menu'
        ? 4.5
        : this.battleStage === 'grapple' || this.battleStage === 'finisher-spread'
          ? 8.5
          : 6.8
    this.cameraAnchor.lerp(targetCam, 1 - Math.exp(-dt * camRate))
    this.lookAnchor.lerp(targetLook, 1 - Math.exp(-dt * (camRate + 1.6)))
    this.camera.position.copy(this.cameraAnchor)

    this.fovKick += (0 - this.fovKick) * (1 - Math.exp(-dt * 10))
    const narrowCompensation = Math.max(0, (1.18 - this.viewportAspect) * 14)
    const desiredFov = THREE.MathUtils.clamp(desiredBaseFov + narrowCompensation + this.fovKick, 34, 70)
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

  private resolveActionGuide(): ActionGuideKind | null {
    if (this.phase === 'transform') return 'transform'
    if (this.phase !== 'fighting') return null
    if (this.battleStage === 'finisher-spread') return 'beam-spread'
    if (this.battleStage === 'finisher-beam') return 'beam-fire'
    if (this.battleStage === 'grapple') return 'grapple'
    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') return null
    const fight = this.kaiju.encounter
    if (fight.state === 'windup' && !this.beamClashActive) {
      return this.battleStage === 'ranged' && fight.attack === 'fireball' ? 'dodge-shoot' : 'guard'
    }
    if (fight.state === 'guarding') return 'kick-break'
    if (this.battleStage === 'ranged') return 'dodge-shoot'
    return 'punch'
  }

  public getHudSnapshot(): BattleHudState {
    const spec = MONSTER_WAVES[this.waveIndex] ?? MONSTER_WAVES[0]!
    const fight = this.kaiju.encounter
    const canWarn =
      this.phase === 'fighting' &&
      (this.battleStage === 'melee' || this.battleStage === 'ranged') &&
      fight.state === 'windup' &&
      !this.beamClashActive

    let warningTextKey: string | null = null
    if (canWarn) {
      warningTextKey =
        fight.attack === 'fireball'
          ? 'warningFireball'
          : fight.attack === 'dark-beam'
            ? 'warningDarkBeam'
            : 'warningMelee'
    }

    let chargeKind: BattleHudState['chargeKind'] = null
    let chargeProgress = 0
    if (this.phase === 'transform') {
      chargeKind = 'transform'
      chargeProgress = this.transformProgress
    } else if (this.battleStage === 'finisher-spread') {
      chargeKind = 'spread'
      chargeProgress = this.finisherSpreadProgress
    } else if (this.isHeroGuarding()) {
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
    const finisherPhase: BattleHudState['finisherPhase'] =
      this.battleStage === 'finisher-spread'
        ? 'spread'
        : this.battleStage === 'finisher-beam'
          ? 'beam'
          : 'none'

    return {
      phase: this.phase,
      battleStage: this.battleStage,
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
      grappleActive: this.phase === 'fighting' && this.battleStage === 'grapple',
      grappleProgress: this.grappleProgress,
      transformProgress: this.transformProgress,
      finisherPhase,
      finisherProgress:
        finisherPhase === 'spread' ? this.finisherSpreadProgress : this.finisherBeamFired ? 1 : 0,
      actionGuide: this.resolveActionGuide(),
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
    this.composer.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
