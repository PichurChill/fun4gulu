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
  BattleRank,
  BattleStage,
  ConcreteSceneTheme,
  ControlMode,
  DistanceHint,
  FloatingDamageEvent,
  GameMode,
  GamePhase,
  GestureActiveCue,
  HeroAction,
  MonsterAttackKind,
  PoseLandmark,
  PunchStyle,
  SceneTheme,
  StrikeHeight,
} from './types'

export interface EngineCallbacks {
  onHudUpdate: (state: BattleHudState) => void
  onFloatingText: (evt: FloatingDamageEvent) => void
}

interface PendingMeleeStrike {
  damage: number
  impact: Impact
  side: 'left' | 'right'
  height: StrikeHeight
  color: string
  isCritical: boolean
  isFinisher: boolean
  isKick: boolean
  settled: boolean
}

interface BufferedCombatInput {
  kind: 'punch' | 'kick' | 'disc' | 'beam'
  side: 'left' | 'right'
  style: PunchStyle
  power: number
  height: StrikeHeight
  jumping?: boolean
  expiresAt: number
}

const DISC_MAX_COOLDOWN = 1.65
const BEAM_MAX_COOLDOWN = 2.1
const MELEE_PUNCH_COOLDOWN = 0.24
const RANGED_PALM_COOLDOWN = 0.3
const KICK_MIN_COOLDOWN = 0.44
const INPUT_BUFFER_WINDOW = 0.16

/**
 * 3D 奥特曼体感格斗主引擎（自由动作连招 + 接触帧硬核打击感 + 条件触发特摄名场面）：
 * - 1:1 动作风格映射（左右直拳/摆拳/上勾/手刀/推掌/飞踢）+ 160ms 输入缓冲零吃招
 * - 近战真实接触帧判定（淘汰隔空甜甜圈，在拳/脚接触窗口于真实骨骼处炸裂火花/碎石/动态点光）
 * - 分层顿帧 + 顿帧期间怪兽 48Hz 高频震颤 + 部位差异受击动画
 * - 真实空间闪避（深蹲躲高位、起跳躲低位、跨步躲火球）触发 0.36s 子弹时间 + 反击增伤
 * - 护盾耐力系统防死防 + 精准弹反振开震晕怪兽
 * - 自由战斗为主：支持主动开启残血终结大招、迎击哥莫拉冲锋进角力、迎击暗黑光线进对波、体感试招靶场与开场站位校准
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

  // 模式与核心战斗状态
  private phase: GamePhase = 'menu'
  private gameMode: GameMode = 'story'
  private battleStage: BattleStage = 'melee'
  private stageTimer = 0
  private calibrationProgress = 0
  private menuOrbitFocus: 'center' | 'hero' | 'monster' = 'center'
  private menuFocusTimer = 0

  private heroProfile: HeroProfile = HERO_PROFILES.tiga
  private heroFormIndex = 0
  private controlMode: ControlMode = 'camera'
  private preferredTheme: SceneTheme = 'auto'
  private loadingProgress = 0
  private waveIndex = 0
  private monsterHp = 1120
  private monsterMaxHp = 1120
  private heroHp = 100
  private readonly heroMaxHp = 100
  private guardStamina = 100
  private guardBrokenCooldown = 0
  private energy = 50
  private score = 0
  private punchChain = 0
  private manualPunchCycle = 0
  private lastPunchSide: 'left' | 'right' | null = null
  private chainTimeLeft = 0
  private combo = 0
  private maxCombo = 0
  private comboResetTimer = 0
  private perfectGuards = 0
  private perfectDodges = 0
  private totalHeroDamageTaken = 0
  private finisherKillCount = 0
  private defeatedCount = 0

  private waveTransitionTimer = 0

  // 接触帧近战挂起槽与 160ms 输入缓冲
  private pendingMeleeStrike: PendingMeleeStrike | null = null
  private bufferedInput: BufferedCombatInput | null = null

  // 子弹时间与反击增伤窗口
  private bulletTimeLeft = 0
  private counterBonusTimer = 0

  // 变身、角力、主动终结光线状态
  private transformProgress = 0
  private transformBurstPlayed = false
  private transformHoldAfterTrigger = 0
  private grappleProgress = 0.48
  private grappleTimeLeft = 0
  private grappleSfxCooldown = 0
  private grappleTriggeredThisWave = false
  private finisherSpreadProgress = 0
  private finisherBeamFired = false
  private finisherBeamWaitTimer = 0
  private finisherTickTimer = 0
  private rainbowSfxCooldown = 0
  private lastDodgeTriggerAt = -Infinity

  // 招式冷却与对波
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

  // 键盘/触屏输入状态
  private manualLean = 0
  private manualGuard = false
  private manualCrouch = false
  private manualJumpTimer = 0
  private manualSpreadHeld = false
  private guardStartedAt = -Infinity
  private wasGuarding = false

  // 摄像头体感快照状态
  private gestureLean = 0
  private gestureGuard = false
  private gestureCrouching = false
  private gestureJumping = false
  private gestureTracking = false
  private gestureCoverage: 'none' | 'upper' | 'full' = 'none'
  private gestureDistanceHint: DistanceHint = 'ok'
  private gestureActiveCue: GestureActiveCue = 'none'
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

  // 视觉冲击帧与镜头动效
  private hitStopTimer = 0
  private shakeTrauma = 0
  private fovKick = 0
  private impactFlashKind: BattleHudState['impactFlashKind'] = 'none'
  private impactFlashSeq = 0
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

    // 选择性 Bloom 后处理管线（阈值 0.96 仅让高能光效与复眼辉光，绝不泛白起雾）
    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.25, 0.26, 0.96)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())

    this.arena = new ArenaManager(this.scene, this.renderer)
    this.hero = new HeroController(this.scene, { baseZ: 7.4 })
    this.kaiju = new KaijuController(this.scene)
    this.effects = new BattleEffects(this.scene)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.lastTimestamp = performance.now()
    this.loop(this.lastTimestamp)
  }

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
    this.menuOrbitFocus = 'hero'
    this.menuFocusTimer = 2.4
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
    this.menuOrbitFocus = 'monster'
    this.menuFocusTimer = 2.6
    const spec = MONSTER_WAVES[clamped]!
    this.audio.setMonster(spec.id)
    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(clamped)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed || this.phase !== 'menu') return
    // 加坦杰厄体宽纵深极大，机库预览退后数米完整展示邪神全貌
    const previewZ = spec.id === 'gatanothor' ? -9.5 : -3.4
    this.kaiju.setStageAnchor(previewZ, 11.6)
    this.kaiju.encounter.enter('idle')
    this.audio.playRoar(spec.id)
    this.emitHud()
  }

  public previewNextForm() {
    if (!this.heroProfile.forms) return
    this.heroFormIndex = (this.heroFormIndex + 1) % this.heroProfile.forms.length
    const form = this.activeForm!
    this.applyHeroForm()
    this.menuOrbitFocus = 'hero'
    this.menuFocusTimer = 2.0
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
    const counterMul = this.counterBonusTimer > 0 ? 1.4 : 1
    return this.heroProfile.baseDamageMul * (this.activeForm?.damageMul ?? 1) * counterMul
  }

  private get totalEnergyMul(): number {
    return this.heroProfile.baseEnergyGainMul * (this.activeForm?.energyGainMul ?? 1)
  }

  private gainEnergy(baseAmount: number) {
    this.energy = Math.min(100, this.energy + baseAmount * this.totalEnergyMul)
  }

  private triggerImpactFlash(kind: BattleHudState['impactFlashKind']) {
    this.impactFlashKind = kind
    this.impactFlashSeq++
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
    this.effects.flashDynamicLight(pos, form.accentColor, 28, 0.35)
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

  public skipCalibration() {
    if (this.phase !== 'calibrating') return
    if (this.gameMode === 'practice') {
      void this.loadWave(this.waveIndex, true)
    } else {
      this.beginTransformPhase()
    }
  }

  public triggerManualTransform() {
    if (this.phase === 'calibrating') {
      this.skipCalibration()
      return
    }
    if (this.phase !== 'transform' || this.transformBurstPlayed) return
    this.completeTransformBurst()
  }

  public setManualSpread(active: boolean) {
    this.manualSpreadHeld = active
  }

  public setManualCrouch(active: boolean) {
    if (active && !this.manualCrouch && this.phase === 'fighting') {
      this.hero.triggerAction('crouch-dodge', 0.42)
      this.audio.playDodge()
    }
    this.manualCrouch = active
  }

  public triggerManualJump() {
    if (this.phase !== 'fighting') return
    if (this.manualJumpTimer <= 0) {
      this.manualJumpTimer = 0.56
      this.hero.triggerAction('jump-kick', 0.56)
      this.audio.playSwing('right', true)
      if (this.battleStage === 'melee') {
        this.pendingMeleeStrike = {
          damage: Math.round(58 * this.totalDamageMul),
          impact: 'heavy',
          side: 'right',
          height: 'high',
          color: '#fb923c',
          isCritical: true,
          isFinisher: true,
          isKick: true,
          settled: false,
        }
      }
    }
  }

  public async startGame(
    mode: ControlMode,
    startWaveIndex = 0,
    theme: SceneTheme = this.preferredTheme,
    gameMode: GameMode = 'story',
  ): Promise<void> {
    this.controlMode = mode
    this.preferredTheme = theme
    this.gameMode = gameMode
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
    this.guardStamina = 100
    this.guardBrokenCooldown = 0
    this.energy = gameMode === 'practice' ? 100 : 50
    this.score = 0
    this.combo = 0
    this.maxCombo = 0
    this.perfectGuards = 0
    this.perfectDodges = 0
    this.totalHeroDamageTaken = 0
    this.finisherKillCount = 0
    this.defeatedCount = 0
    this.bulletTimeLeft = 0
    this.counterBonusTimer = 0
    this.pendingMeleeStrike = null
    this.bufferedInput = null
    this.manualLean = 0
    this.manualGuard = false
    this.manualCrouch = false
    this.manualJumpTimer = 0
    this.manualSpreadHeld = false
    this.wasGuarding = false
    this.guardStartedAt = -Infinity
    this.gestureLean = 0
    this.gestureGuard = false
    this.gestureCrouching = false
    this.gestureJumping = false
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

    const spec = MONSTER_WAVES[this.waveIndex]!
    await Promise.all([
      this.arena.setTheme(this.resolveThemeForWave(this.waveIndex)),
      this.kaiju.spawn(this.loader, spec),
    ])
    if (this.disposed) return

    // 体感模式先做 1.5s 快捷站位校准（可随时一键跳过）；键盘模式直接进场
    if (mode === 'camera') {
      this.phase = 'calibrating'
      this.calibrationProgress = 0
      this.loadingProgress = 100
      this.kaiju.root.visible = false
      this.arena.setCosmicMode(true)
      this.hero.resetPose()
      this.hero.setStageBaseZ(12.2, true)
      this.emitHud()
    } else if (gameMode === 'practice') {
      await this.loadWave(this.waveIndex, true)
    } else {
      this.beginTransformPhase()
    }
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
    this.transformHoldAfterTrigger = 0.9
    this.hero.triggerAction('transform', 1.2)
    this.audio.playTransform('rise')
    this.addTrauma(0.55)
    this.fovKick = -5.0
    const burstPos = new THREE.Vector3(0, 10.5, 12.0)
    this.effects.spawnBurst(burstPos, 0xfacc15, 42, 34, 1.55)
    this.effects.spawnEnergyShockSphere(burstPos, this.heroProfile.accentColor, 9.5)
    this.effects.spawnImpactRing(burstPos, 0xffffff, 14)
    this.effects.spawnHitFlash(burstPos, 0xffffff, 2.5)
    this.effects.flashDynamicLight(burstPos, 0xfacc15, 46, 0.45)
    this.showBanner('bannerTransform', 1.1)
    this.emitHud()
  }

  private async loadWave(index: number, skipReloadIfSame = false): Promise<void> {
    const spec = MONSTER_WAVES[index]!
    this.audio.setMonster(spec.id)
    this.feetTracked = false
    this.jump.reset()
    this.punchChain = 0
    this.manualPunchCycle = 0
    this.chainTimeLeft = 0
    this.pendingMeleeStrike = null
    this.bufferedInput = null
    this.waveIndex = index
    this.monsterMaxHp = spec.maxHp
    this.monsterHp = spec.maxHp
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.grappleTriggeredThisWave = false
    this.effects.clearAllDynamic()

    this.battleStage = 'melee'
    this.stageTimer = 0
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

    // 紧贴真实拳脚打击距落位（严格以怪兽前表面 + 安全距离排布，拳到肉且零穿模！）
    const safeKaijuZ = Math.min(-1.8, -(this.kaiju.frontExtentZ - 0.8))
    this.hero.resetPose()
    this.hero.setStageBaseZ(7.6, true)
    this.hero.setLeanRange(5.8)
    this.kaiju.root.visible = true
    this.kaiju.setStageAnchor(safeKaijuZ, 7.6, null)
    this.kaiju.encounter.reset()

    this.loadingProgress = 100
    this.audio.setAmbience(this.arena.getTheme(), true)

    if (this.gameMode === 'practice') {
      this.kaiju.encounter.enter('idle')
      this.phase = 'fighting'
      this.showBanner('bannerPracticeStart', 1.4)
    } else {
      this.phase = 'intro'
      this.waveTransitionTimer = 1.05
      this.addTrauma(0.38)
      this.showBanner('bannerWaveStart', 1.35)
    }
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.battleStage = 'melee'
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.pendingMeleeStrike = null
    this.bufferedInput = null
    this.bulletTimeLeft = 0
    this.arena.setCosmicMode(false)
    this.audio.setDangerAlarm(false)
    this.audio.setChargeHum(0)
    this.audio.setAmbience(this.arena.getTheme(), false)
    this.effects.clearAllDynamic()
    this.hero.resetPose()
    this.hero.setLookTarget(null)
    this.hero.setStageBaseZ(11.6, true)
    this.hero.setLeanRange(5.5)
    this.hero.triggerAction('pose-intro', 0.8)
    this.kaiju.root.visible = true
    // 加坦杰厄体宽纵深极大，机库预览退后数米完整展示邪神全貌
    const previewZ = this.kaiju.getSpec()?.id === 'gatanothor' ? -9.5 : -3.4
    this.kaiju.setStageAnchor(previewZ, 11.6)
    this.kaiju.encounter.directorLocked = false
    this.kaiju.encounter.enter('idle')
    this.emitHud()
  }

  public setPaused(paused: boolean) {
    this.paused = paused
    this.audio.setDangerAlarm(
      !paused && this.heroHp > 0 && this.heroHp <= this.heroMaxHp * 0.3 && this.phase === 'fighting',
    )
    if (paused) this.audio.setChargeHum(0)
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
    if (muted) {
      this.audio.setDangerAlarm(false)
      this.audio.setChargeHum(0)
      this.audio.setAmbience(this.arena.getTheme(), false)
    } else if (this.phase === 'fighting') {
      this.audio.setAmbience(this.arena.getTheme(), true)
    }
  }

  /** 是否已达到主动终结技释放条件（怪兽残血 < 26% 或破防眩晕，玩家能量 >= 50） */
  private isFinisherReady(): boolean {
    if (this.phase !== 'fighting' || this.gameMode === 'practice') return false
    if (this.battleStage !== 'melee' && this.battleStage !== 'ranged') return false
    if (this.beamClashActive) return false
    const hpRatio = this.monsterHp / Math.max(1, this.monsterMaxHp)
    return (
      (hpRatio <= 0.26 || this.kaiju.encounter.state === 'stunned') &&
      this.energy >= 45
    )
  }

  public triggerManualFinisher() {
    if (!this.isFinisherReady()) return
    this.beginFinisherSpread()
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
    this.gestureDistanceHint = snap.distanceHint
    this.gestureActiveCue = snap.activeCue
    this.gestureMirroredX = snap.mirroredCenterX
    this.gestureLean = snap.lean
    this.gestureGuard = snap.guard && this.guardBrokenCooldown <= 0
    if (snap.guardJustStarted && this.guardBrokenCooldown <= 0) {
      this.guardStartedAt = this.elapsedTime
    }
    this.gestureCrouching = snap.crouching
    this.gestureJumping = snap.jumping
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

    if (this.phase === 'calibrating') return

    // 变身仪式
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

    // 主动触发残血终结技：残血就绪窗期间双臂展开即可切入七彩棱镜必杀演出！
    if (this.isFinisherReady() && snap.spreadProgress >= 0.45) {
      this.beginFinisherSpread()
      return
    }

    if (this.battleStage === 'grapple') {
      if (snap.punch || physicalKick) {
        this.boostGrapple(0.09)
      }
      return
    }

    if (this.battleStage === 'finisher-spread') {
      if (snap.spreadProgress >= 0.82) {
        this.finisherSpreadProgress = 1
      }
      return
    }
    if (this.battleStage === 'finisher-beam') {
      if (
        !this.finisherBeamFired &&
        (snap.beamTrigger || snap.beamHolding || snap.beamCharge > 0.16 || snap.punch)
      ) {
        this.fireFinisherSuperBeam()
      }
      return
    }

    if (this.battleStage === 'transition-ranged' || this.battleStage === 'grapple-finish') {
      return
    }

    // 瞬时侧滑步触发
    if (
      Math.abs(snap.lateralVelocity) > 2.3 &&
      this.elapsedTime - this.lastDodgeTriggerAt > 0.42
    ) {
      this.lastDodgeTriggerAt = this.elapsedTime
      this.hero.triggerAction(snap.lateralVelocity < 0 ? 'dodge-left' : 'dodge-right', 0.3)
    }

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
      this.dispatchCombatAction({
        kind: 'kick',
        side: 'right',
        style: 'jab',
        power: 0.95,
        height: 'high',
        jumping: true,
        expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
      })
    } else if (snap.typeTrigger) {
      this.switchHeroForm()
    } else if (snap.beamTrigger) {
      this.dispatchCombatAction({
        kind: 'beam',
        side: snap.beamArmSide,
        style: 'palm',
        power: 1,
        height: 'mid',
        expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
      })
    } else if (snap.discTrigger) {
      this.dispatchCombatAction({
        kind: 'disc',
        side: snap.discTrigger,
        style: 'chop',
        power: 0.9,
        height: 'mid',
        expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
      })
    } else if (physicalKick) {
      this.dispatchCombatAction({
        kind: 'kick',
        side: physicalKick,
        style: 'jab',
        power: 0.92,
        height: 'mid',
        jumping: false,
        expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
      })
    } else if (snap.punch) {
      this.dispatchCombatAction({
        kind: 'punch',
        side: snap.punch,
        style: snap.punchStyle,
        power: snap.punchPower,
        height: snap.punchHeight,
        expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
      })
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
      dir !== 0 &&
      dir !== this.manualLean &&
      this.elapsedTime - this.lastDodgeTriggerAt > 0.34
    ) {
      this.lastDodgeTriggerAt = this.elapsedTime
      this.hero.triggerAction(dir < 0 ? 'dodge-left' : 'dodge-right', 0.28)
    }
    this.manualLean = dir
  }

  public setManualGuard(active: boolean) {
    if (active && this.guardBrokenCooldown > 0) return
    if (active && !this.manualGuard) {
      this.guardStartedAt = this.elapsedTime
    }
    this.manualGuard = active
  }

  public triggerManualPunch(side: 'left' | 'right', styleOverride?: PunchStyle) {
    if (this.phase === 'calibrating' || this.phase === 'transform') {
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

    // 键盘/触屏连续出拳自然演进：直拳 → 摆拳 → 手刀 → 上勾重拳
    const styleCycle: PunchStyle[] = ['jab', 'hook', 'chop', 'uppercut']
    const heightCycle: StrikeHeight[] = ['mid', 'mid', 'high', 'high']
    const idx = this.manualPunchCycle % styleCycle.length
    this.manualPunchCycle++
    const style = styleOverride ?? styleCycle[idx]!
    const height = heightCycle[idx]!

    this.dispatchCombatAction({
      kind: 'punch',
      side,
      style,
      power: style === 'uppercut' || style === 'hook' ? 0.92 : 0.72,
      height,
      expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
    })
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
    this.dispatchCombatAction({
      kind: 'kick',
      side,
      style: 'jab',
      power: 0.94,
      height: 'mid',
      jumping: false,
      expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
    })
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
    this.dispatchCombatAction({
      kind: 'disc',
      side,
      style: 'chop',
      power: 0.9,
      height: 'mid',
      expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
    })
  }

  public triggerManualBeam() {
    if (this.phase === 'calibrating' || this.phase === 'transform') {
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
    // 残血终结窗就绪时直接按光线键一键进入七彩终结技！
    if (this.isFinisherReady()) {
      this.beginFinisherSpread()
      return
    }
    this.dispatchCombatAction({
      kind: 'beam',
      side: 'right',
      style: 'palm',
      power: 1,
      height: 'mid',
      expiresAt: this.elapsedTime + INPUT_BUFFER_WINDOW,
    })
  }

  /** 160ms 输入缓冲调度器：若当前正在冷却则暂存，冷却完毕立即无缝衔接 */
  private dispatchCombatAction(input: BufferedCombatInput) {
    if (this.tryExecuteInput(input)) {
      this.bufferedInput = null
    } else {
      this.bufferedInput = input
    }
  }

  private tryExecuteInput(input: BufferedCombatInput): boolean {
    if (this.effects.isHeroBeamActive()) return false
    if (input.kind === 'punch') {
      if (this.punchCooldown > 0) return false
      this.executePunch(input.side, input.style, input.power, input.height)
      return true
    }
    if (input.kind === 'kick') {
      if (this.kickCooldown > 0) return false
      this.executeKick(input.side, !!input.jumping)
      return true
    }
    if (input.kind === 'disc') {
      if (this.discCooldown > 0) return false
      this.executeDisc(input.side)
      return true
    }
    if (input.kind === 'beam') {
      if (this.beamCooldown > 0) return false
      this.executeBeam()
      return true
    }
    return false
  }

  /** 挥拳/飞踢/光轮正面弹反击碎逼近的怪兽火球或加恩Q反吐紫弹 */
  private deflectNearbyFireballs(reachZ = 6.5): boolean {
    let deflected = false
    const kaijuCenter = this.kaiju.getTargetCenter()
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      const proj = this.effects.projectiles[i]!
      if (proj.fromHero || proj.hitTriggered || proj.kind !== 'kaiju-fireball') continue
      const dz = this.hero.baseZ - proj.pos.z
      const dx = Math.abs(this.hero.currentX - proj.pos.x)
      if (dz >= -1.2 && dz <= reachZ && dx <= 4.8) {
        const hitPos = proj.pos.clone()
        this.effects.removeProjectileAt(i)
        this.effects.spawnBurst(hitPos, 0xfacc15, 24, 28, 1.3)
        this.effects.spawnImpactRing(hitPos, 0xfef08a, 6.8)
        this.effects.spawnHitFlash(hitPos, 0xffffff, 1.4)
        this.effects.flashDynamicLight(hitPos, 0xfacc15, 28, 0.28)
        this.effects.spawnPalmBolt(
          hitPos,
          kaijuCenter,
          Math.round(52 * this.totalDamageMul),
          'right',
        )
        this.audio.playDeflect()
        this.gainEnergy(20)
        this.score += 360
        this.addHitStop(0.06)
        this.addTrauma(0.35)
        this.triggerImpactFlash('parry')
        this.spawnFloatingAtWorld(
          hitPos.clone().add(new THREE.Vector3(0, 2.2, 0)),
          'DEFLECT!',
          '#fde047',
          1.28,
          'guard',
        )
        deflected = true
      }
    }
    return deflected
  }

  private mapPunchToHeroAction(
    side: 'left' | 'right',
    style: PunchStyle,
    isFinisher: boolean,
  ): { action: HeroAction; dur: number; slashColor: number; slashEuler: [number, number, number]; impact: Impact } {
    if (style === 'uppercut') {
      return {
        action: side === 'left' ? 'uppercut-left' : 'uppercut-right',
        dur: 0.44,
        slashColor: 0xfacc15,
        slashEuler: [0.65, side === 'left' ? 0.35 : -0.35, side === 'left' ? 0.95 : -0.95],
        impact: 'heavy',
      }
    }
    if (style === 'hook') {
      return {
        action: side === 'left' ? 'hook-left' : 'hook-right',
        dur: 0.4,
        slashColor: 0xff5a2c,
        slashEuler: [0.18, side === 'left' ? 0.25 : -0.25, side === 'left' ? -0.4 : 2.6],
        impact: isFinisher ? 'heavy' : 'light',
      }
    }
    if (style === 'chop') {
      return {
        action: side === 'left' ? 'chop-left' : 'chop-right',
        dur: 0.38,
        slashColor: 0x38e8ff,
        slashEuler: [-0.35, 0.15, side === 'left' ? -1.1 : 1.1],
        impact: isFinisher ? 'heavy' : 'light',
      }
    }
    if (style === 'palm') {
      return {
        action: side === 'left' ? 'palm-left' : 'palm-right',
        dur: 0.34,
        slashColor: this.heroProfile.beamColor,
        slashEuler: [0.12, 0, 0],
        impact: 'light',
      }
    }
    return {
      action: isFinisher ? 'punch-heavy' : side === 'left' ? 'punch-left' : 'punch-right',
      dur: isFinisher ? 0.44 : 0.32,
      slashColor: isFinisher ? 0xfacc15 : this.heroProfile.burstColor,
      slashEuler: [0.22, 0.15, side === 'left' ? -0.5 : 2.5],
      impact: isFinisher ? 'heavy' : 'light',
    }
  }

  private executePunch(
    side: 'left' | 'right',
    style: PunchStyle = 'jab',
    power = 0.78,
    height: StrikeHeight = 'mid',
  ) {
    if (this.effects.isHeroBeamActive() || this.punchCooldown > 0) return

    // 远程或明确推掌距离过远时：发射高速掌心奥特光弹
    const distZ = this.hero.root.position.z - this.kaiju.getFrontSurfaceZ()
    if (this.battleStage === 'ranged' || (style === 'palm' && distZ > 9.0)) {
      this.punchCooldown = RANGED_PALM_COOLDOWN
      this.hero.triggerAction(side === 'left' ? 'palm-left' : 'palm-right', 0.32)
      if (this.deflectNearbyFireballs(6.8)) {
        this.emitHud()
        return
      }
      const origin = this.hero.getFistOrigin(side)
      const target = this.kaiju.getTargetCenter(height)
      const dmg = Math.round((28 + power * 10) * this.totalDamageMul)
      this.effects.spawnPalmBolt(origin, target, dmg, side)
      this.effects.spawnBurst(origin, this.heroProfile.beamColor, 8, 15, 0.7)
      this.audio.playPalmShot()
      this.emitHud()
      return
    }

    // 近身真实 1:1 格斗出拳：不发隔空甜甜圈，交由真实接触帧窗口引爆！
    this.punchCooldown = MELEE_PUNCH_COOLDOWN
    this.punchChain = this.chainTimeLeft > 0 && this.lastPunchSide !== side ? this.punchChain + 1 : 1
    const isFinisher = this.punchChain >= 3 || style === 'uppercut'
    if (this.punchChain >= 3) this.punchChain = 3
    this.lastPunchSide = side
    this.chainTimeLeft = isFinisher ? 0 : 1.85

    const mapped = this.mapPunchToHeroAction(side, style, isFinisher)
    this.hero.triggerAction(mapped.action, mapped.dur)
    if (isFinisher) this.fovKick = -2.8

    const slashCenter = new THREE.Vector3(
      this.hero.currentX + (side === 'left' ? -0.6 : 0.6),
      height === 'high' ? 10.6 : 9.1,
      this.hero.root.position.z - 3.3,
    )
    this.effects.spawnMeleeSlash(
      slashCenter,
      mapped.slashColor,
      mapped.slashEuler,
      isFinisher ? 1.38 : 1.08,
      side === 'left' ? -1 : 1,
    )
    this.audio.playSwing(side, false)

    if (this.deflectNearbyFireballs(6.5) && !isFinisher) {
      this.emitHud()
      return
    }

    const baseDmg =
      style === 'uppercut'
        ? 46
        : style === 'hook' || style === 'chop'
          ? 36
          : isFinisher
            ? 44
            : 26
    const finalDmg = Math.round(baseDmg * (0.8 + power * 0.35) * this.totalDamageMul)
    this.pendingMeleeStrike = {
      damage: finalDmg,
      impact: mapped.impact,
      side,
      height: style === 'uppercut' ? 'high' : height,
      color: isFinisher ? '#fef08a' : style === 'chop' ? '#67e8f9' : '#fde047',
      isCritical: isFinisher || this.counterBonusTimer > 0,
      isFinisher,
      isKick: false,
      settled: false,
    }
    if (isFinisher) this.punchChain = 0
    this.emitHud()
  }

  private executeKick(side: 'left' | 'right', jumping = false) {
    if (this.effects.isHeroBeamActive() || this.kickCooldown > 0) return
    this.kickCooldown = KICK_MIN_COOLDOWN
    const action = jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right'
    this.hero.triggerAction(action, jumping ? 0.56 : 0.46)
    this.fovKick = jumping ? -3.6 : -2.6
    this.deflectNearbyFireballs(6.6)

    const slashCenter = new THREE.Vector3(
      this.hero.currentX,
      9.8,
      this.hero.root.position.z - 3.6,
    )
    this.effects.spawnMeleeSlash(slashCenter, 0xf97316, [1.18, 0.15, 0], 1.5, -1.6)
    this.audio.playSwing(side, true)
    this.showBanner(jumping ? 'bannerJumpKick' : 'bannerKick', 0.85)

    // 近战踢击同样采用真实接触帧爆裂；远程踢击发射火旋踢波
    if (this.battleStage === 'ranged') {
      const origin = this.hero.getFootOrigin(side)
      const target = this.kaiju.getTargetCenter('mid')
      this.effects.spawnKickWave(
        origin,
        target,
        Math.round((jumping ? 64 : 48) * this.totalDamageMul),
      )
    } else {
      this.pendingMeleeStrike = {
        damage: Math.round((jumping ? 66 : 52) * this.totalDamageMul),
        impact: 'heavy',
        side,
        height: jumping ? 'high' : 'mid',
        color: '#fb923c',
        isCritical: true,
        isFinisher: true,
        isKick: true,
        settled: false,
      }
    }
  }

  private executeDisc(side: 'left' | 'right') {
    if (this.effects.isHeroBeamActive() || this.discCooldown > 0) return
    const cdMul = this.activeForm?.discCooldownMul ?? 1
    this.discCooldown = DISC_MAX_COOLDOWN * cdMul
    this.hero.setDiscCharge(0, side)
    this.hero.triggerAction('disc', 0.46)
    this.deflectNearbyFireballs(6.8)

    const origin = this.hero.getDiscOrigin(side)
    const target = this.kaiju.getTargetCenter('mid')
    this.effects.spawnUltraDisc(origin, target, Math.round(74 * this.totalDamageMul))
    this.audio.playDisc()
    this.showBanner(`bannerDisc${this.heroProfile.bannerKey}`, 1.0)
    this.emitHud()
  }

  private executeBeam() {
    if (this.effects.isHeroBeamActive() || this.beamCooldown > 0) return
    if (this.energy < 35 && this.gameMode !== 'practice') {
      this.spawnFloatingAtWorld(
        this.hero.root.position.clone().add(new THREE.Vector3(0, 14, 0)),
        'ENERGY LOW!',
        '#facc15',
        0.95,
      )
      return
    }
    const isSuper = this.energy >= 100
    if (this.gameMode !== 'practice') {
      this.energy = Math.max(0, this.energy - (isSuper ? 100 : 35))
    }
    this.beamCooldown = BEAM_MAX_COOLDOWN

    const fight = this.kaiju.encounter
    const spec = MONSTER_WAVES[this.waveIndex]!
    if (
      fight.attack === 'dark-beam' &&
      ((fight.state === 'windup' && fight.time >= 0.2) || fight.state === 'attack')
    ) {
      this.startBeamClash(isSuper, spec.accentColor)
      return
    }

    const dur = isSuper ? 1.8 : 1.25
    this.hero.triggerAction('beam', dur)
    this.effects.startHeroBeam(isSuper, dur)
    this.effects.flashDynamicLight(
      this.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, -2)),
      isSuper ? this.heroProfile.beamSuperColor : this.heroProfile.beamColor,
      36,
      0.45,
    )
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

  // ---- 条件自然触发特摄名场面（角力过肩摔 / 主动必杀终结 / 双光线对波） ----

  private beginGrappleStage() {
    this.grappleTriggeredThisWave = true
    this.battleStage = 'grapple'
    this.stageTimer = 0
    this.grappleProgress = 0.46
    this.grappleTimeLeft = 6.2
    this.pendingMeleeStrike = null
    this.effects.clearAllDynamic()

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
      this.kaiju.setStageAnchor(-13.0, 8.2, 0)
      this.effects.spawnBurst(clashPos, 0xfacc15, 36, 32, 1.45)
      this.effects.spawnDebris(clashPos, 14, 20)
      this.effects.spawnEnergyShockSphere(clashPos, 0x38e8ff, 8.2)
      this.effects.spawnImpactRing(clashPos, 0xfef08a, 11)
      this.effects.flashDynamicLight(clashPos, 0xfacc15, 42, 0.4)
      this.audio.playHeavyImpact()
      this.audio.playExplosion()
      this.addHitStop(0.095)
      this.addTrauma(0.75)
      this.fovKick = -4.5
      this.triggerImpactFlash('heavy')
      this.gainEnergy(38)
      this.score += 1100
      this.combo += 5
      this.maxCombo = Math.max(this.maxCombo, this.combo)
      this.comboResetTimer = 4.2

      const throwDmg = Math.round(185 * this.totalDamageMul)
      this.monsterHp = Math.max(1, this.monsterHp - throwDmg)
      this.spawnFloatingAtWorld(
        this.kaiju.getTargetCenter(),
        `-${throwDmg}!`,
        '#fef08a',
        1.48,
        'crit',
      )
      this.showBanner('bannerGrappleWin', 1.4)
    } else {
      this.hero.triggerAction('hit-heavy', 0.5)
      this.hero.triggerHurtFlash(0.85)
      this.kaiju.encounter.enter('recovering')
      this.kaiju.setStageAnchor(-2.0, 7.6, null)
      this.hero.setStageBaseZ(7.6, false)
      this.hero.setLeanRange(5.8)
      this.heroHp = Math.max(12, this.heroHp - 12)
      this.totalHeroDamageTaken += 12
      this.audio.playHeroHurt()
      this.addTrauma(0.45)
      this.triggerImpactFlash('hurt')
    }
    this.emitHud()
  }

  private beginFinisherSpread() {
    this.battleStage = 'finisher-spread'
    this.stageTimer = 0
    this.finisherSpreadProgress = 0
    this.finisherBeamFired = false
    this.pendingMeleeStrike = null
    this.effects.clearAllDynamic()
    this.hero.currentX = 0
    this.hero.setLeanRange(0)
    this.hero.setLean(0)
    this.hero.setStageBaseZ(12.0, true)
    this.hero.triggerAction('beam-spread', 12)
    this.kaiju.encounter.directorLocked = true
    this.kaiju.encounter.enter('stunned')

    const portrait = THREE.MathUtils.clamp((0.92 - this.viewportAspect) / 0.46, 0, 1)
    this.kaiju.snapToPosition(0, -26.0)
    this.cameraAnchor.set(0, THREE.MathUtils.lerp(10.15, 9.6, portrait), 0.6 - portrait * 12.2)
    this.lookAnchor.set(0, THREE.MathUtils.lerp(9.85, 8.8, portrait), 12.0)
    this.audio.playRainbowCharge()
    this.showBanner('bannerFinisherCharge', 1.6)
    this.emitHud()
  }

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
    this.effects.flashDynamicLight(burstPos, 0x38e8ff, 38, 0.4)
    this.cameraAnchor.set(18.5, 18.2, 22.8)
    this.lookAnchor.set(0, 8.4, -2.5)
    this.audio.playTransform('type')
    this.addTrauma(0.35)
    this.showBanner('bannerFinisherFire', 1.8)
    this.emitHud()
  }

  private fireFinisherSuperBeam() {
    if (this.finisherBeamFired) return
    this.finisherBeamFired = true
    this.stageTimer = 0
    this.energy = 0
    this.hero.triggerAction('beam', 2.4)
    this.kaiju.encounter.enter('finisher-hit')
    this.effects.startHeroBeam(true, 2.3)
    this.audio.playBeam(true)
    this.addTrauma(0.75)
    this.fovKick = -5.2
    this.triggerImpactFlash('heavy')
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
      this.effects.spawnBurst(center, 0xfef08a, 38, 34, 1.6)
      this.effects.spawnDebris(center, 16, 22)
      this.effects.spawnEnergyShockSphere(center, 0x38e8ff, 7.6)
      this.effects.spawnImpactRing(center, 0xfacc15, 12.5)
      this.effects.spawnHitFlash(center, 0xffffff, 2.2)
      this.effects.flashDynamicLight(center, 0xfef08a, 46, 0.45)
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime, 9.5)
      this.audio.playHeavyImpact()
      this.audio.playExplosion()
      this.kaiju.encounter.enter('stunned')
      this.gainEnergy(28)
      this.score += 750
      this.triggerImpactFlash('heavy')
      this.showBanner('bannerClashWin', 1.25)
      this.applyDamageToMonster(
        Math.round(165 * this.totalDamageMul),
        '#fef08a',
        true,
        'heavy',
        undefined,
        'mid',
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

  private triggerPerfectDodge(label = 'PERFECT DODGE!') {
    this.perfectDodges++
    this.bulletTimeLeft = 0.38
    this.counterBonusTimer = 2.6
    this.gainEnergy(22)
    this.score += 380
    this.audio.playBulletTime()
    this.fovKick = 4.2
    this.triggerImpactFlash('dodge')
    this.effects.spawnImpactRing(
      new THREE.Vector3(this.hero.currentX, 7.5, this.hero.root.position.z),
      0x4ade80,
      7.4,
    )
    this.spawnFloatingAtWorld(
      new THREE.Vector3(this.hero.currentX, 14.2, this.hero.root.position.z),
      label,
      '#4ade80',
      1.3,
      'dodge',
    )
    this.showBanner('bannerPerfectDodge', 1.0)
    this.emitHud()
  }

  private applyDamageToMonster(
    amount: number,
    color: string,
    isCritical = false,
    impact: Impact = 'light',
    punchSide?: 'left' | 'right',
    hitHeight: StrikeHeight = 'mid',
    contactWorldPos?: THREE.Vector3,
  ) {
    if (this.phase !== 'fighting' || this.monsterHp <= 0) return

    const spec = MONSTER_WAVES[this.waveIndex]!
    const res = this.kaiju.encounter.receiveHit(amount, impact, spec)

    // 杰顿波状护盾吸收光线/光弹后立即反吐火球！
    if (res.reflectedByShield) {
      const emitPos = this.kaiju.getAttackEmitOrigin()
      this.effects.spawnBurst(emitPos, 0x38bdf8, 22, 24, 1.2)
      this.effects.spawnImpactRing(emitPos, 0x38bdf8, 7.5)
      this.audio.playDeflect()
      this.spawnFloatingAtWorld(emitPos, 'ABSORBED!', '#38bdf8', 1.22, 'guard')
      this.effects.spawnKaijuFireball(
        emitPos,
        new THREE.Vector3(this.hero.currentX, 8.8, this.hero.baseZ),
        0xff9f1c,
        spec.attackDamage,
        24,
      )
      this.emitHud()
      return
    }

    // 加恩Q 吸能紫瞳吸收光弹
    if (res.absorbed) {
      const emitPos = this.kaiju.getAttackEmitOrigin()
      this.effects.spawnImpactRing(emitPos, 0xc084fc, 6.2)
      this.audio.playDeflect()
      this.spawnFloatingAtWorld(emitPos, 'ABSORB +1', '#c084fc', 1.15, 'guard')
      this.emitHud()
      return
    }

    if (res.damage <= 0) return

    // 试招靶场不杀死怪兽，血量低于 120 自动回满便于持续练招
    if (this.gameMode === 'practice') {
      this.monsterHp = Math.max(120, this.monsterHp - res.damage)
      if (this.monsterHp <= 130) this.monsterHp = this.monsterMaxHp
    } else {
      this.monsterHp = Math.max(0, this.monsterHp - res.damage)
    }

    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.comboResetTimer = 3.8
    this.score += res.damage * (10 + Math.min(25, this.combo))

    const hitPos = contactWorldPos ? contactWorldPos.clone() : this.kaiju.getTargetCenter(hitHeight)
    if (!contactWorldPos && punchSide) hitPos.x += punchSide === 'left' ? -1.4 : 1.4

    this.kaiju.triggerHitReaction(isCritical || res.guardBroken ? 1 : 0.78, punchSide, hitHeight)

    const sparkHex =
      spec.armorMaterial === 'metal'
        ? 0xfef08a
        : spec.armorMaterial === 'eldritch'
          ? 0xd946ef
          : isCritical
            ? 0xfacc15
            : this.heroProfile.beamColor

    this.effects.spawnBurst(
      hitPos,
      sparkHex,
      isCritical || res.guardBroken ? 28 : 16,
      isCritical ? 30 : 22,
      isCritical ? 1.32 : 0.98,
    )

    if (res.illusionBroken) {
      this.showBanner('bannerIllusionBreak', 1.2)
      this.effects.spawnImpactRing(hitPos, 0x38bdf8, 11)
      this.effects.flashDynamicLight(hitPos, 0x38bdf8, 38, 0.38)
      this.triggerImpactFlash('heavy')
    } else if (res.guardBroken) {
      this.showBanner('bannerGuardBreak', 1.15)
      this.effects.spawnDebris(hitPos, 10, 18)
      this.triggerImpactFlash('heavy')
    }

    if (impact === 'heavy' || impact === 'disc' || res.guardBroken) {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime, 5.8)
      this.addHitStop(res.guardBroken ? 0.11 : 0.088)
      this.addTrauma(0.46)
      this.fovKick = -3.2
      this.effects.spawnDebris(hitPos, 9, 16)
      this.effects.spawnEnergyShockSphere(hitPos, 0x38bdf8, 5.4)
      this.effects.spawnImpactRing(hitPos, 0xfef08a, 8.2)
      this.effects.spawnHitFlash(hitPos, isCritical ? 0xfef08a : 0xffffff, 1.55)
      this.effects.flashDynamicLight(hitPos, sparkHex, 30, 0.28)
      this.triggerImpactFlash('heavy')
    } else if (impact === 'light') {
      this.addHitStop(0.045)
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
      `${res.guardBroken ? 'BREAK ' : ''}-${res.damage}${isCritical ? '!' : ''}`,
      res.guardBroken ? '#fb923c' : color,
      isCritical || res.guardBroken ? 1.38 : 1.06,
      isCritical || res.guardBroken ? 'crit' : 'normal',
    )

    if (this.monsterHp <= 0) {
      this.onMonsterDefeated(false)
    }
    this.emitHud()
  }

  private onMonsterDefeated(byFinisher: boolean) {
    if (byFinisher) this.finisherKillCount++
    this.defeatedCount += 1
    this.score += (byFinisher ? 2600 : 1800) + this.waveIndex * 700
    this.beamDamageTicksRemaining = 0
    this.beamClashActive = false
    this.pendingMeleeStrike = null
    this.effects.setBeamClash(false, 0.5)
    this.effects.stopHeroBeam()
    this.kaiju.encounter.directorLocked = false
    this.kaiju.encounter.enter('dying')
    this.audio.playExplosion()
    this.addHitStop(0.14)
    this.addTrauma(0.98)
    this.fovKick = -5.0
    this.triggerImpactFlash('heavy')

    const center = this.kaiju.getTargetCenter()
    this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime, 12.5)
    this.effects.spawnDebris(center, 22, 26)
    this.effects.spawnEnergyShockSphere(center, 0xff5a2c, 11.5)
    this.effects.spawnImpactRing(center, 0xffd28a, 15)
    this.effects.spawnBurst(center, 0xff6b2b, 48, 38, 1.8)
    this.effects.spawnBurst(center.clone().add(new THREE.Vector3(0, 3, 1)), 0xfacc15, 34, 30, 1.5)
    this.effects.spawnHitFlash(center, 0xffffff, 2.8)
    this.effects.flashDynamicLight(center, 0xff7b29, 64, 0.55)

    if (this.waveIndex + 1 >= MONSTER_WAVES.length) {
      this.phase = 'victory'
      this.audio.setDangerAlarm(false)
      this.audio.setChargeHum(0)
      this.audio.setAmbience(this.arena.getTheme(), false)
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

    const isCrouching = this.manualCrouch || this.gestureCrouching
    const isJumping =
      this.manualJumpTimer > 0 || this.gestureJumping || this.hero.getAction() === 'jump-kick'

    // 1. 真实空间立体闪避判定：高位横扫靠深蹲潜闪、低位横扫靠起跳跃过、火球靠跨步侧移！
    if (attack === 'melee-high' && isCrouching) {
      this.hero.triggerAction('crouch-dodge', 0.45)
      this.triggerPerfectDodge('DUCK DODGE!')
      return
    }
    if (attack === 'melee-low' && isJumping) {
      this.triggerPerfectDodge('JUMP DODGE!')
      return
    }
    if (attack === 'fireball' && Math.abs(this.hero.currentX - attackX) > 2.95) {
      this.triggerPerfectDodge('PERFECT DODGE!')
      return
    }

    // 2. 机械哥莫拉/巨兽重装冲锋（charge）：正面迎击或抬盾自然切入高燃角力过肩摔！
    const isGuarding = this.isHeroGuarding()
    if (
      attack === 'charge' &&
      !this.grappleTriggeredThisWave &&
      this.gameMode === 'story' &&
      (isGuarding || this.pendingMeleeStrike !== null)
    ) {
      this.beginGrappleStage()
      return
    }

    // 3. 能量护盾防御 & 精准弹反（Parry）
    if (isGuarding && this.guardBrokenCooldown <= 0) {
      const isJustGuard = this.elapsedTime - this.guardStartedAt <= 0.52
      this.effects.triggerShieldBlockFlash()
      const shieldPos = new THREE.Vector3(this.hero.currentX, 9.2, this.hero.baseZ - 2.6)

      if (isJustGuard) {
        this.audio.playParry()
        this.hero.triggerAction('guard-parry', 0.44)
        this.guardStamina = 100
        if (this.kaiju.encounter.isMeleeLike(attack)) {
          this.kaiju.encounter.enter('staggered')
        }
        this.perfectGuards += 1
        this.counterBonusTimer = 2.6
        this.gainEnergy(30)
        this.score += 480
        this.addHitStop(0.085)
        this.addTrauma(0.38)
        this.triggerImpactFlash('parry')
        this.effects.spawnBurst(shieldPos, 0xfef08a, 28, 28, 1.3)
        this.effects.spawnImpactRing(shieldPos, 0xfef08a, 8.2)
        this.effects.flashDynamicLight(shieldPos, 0xfef08a, 34, 0.3)
        this.spawnFloatingAtWorld(
          new THREE.Vector3(this.hero.currentX, 14.6, this.hero.baseZ),
          'PARRY!',
          '#38bdf8',
          1.34,
          'guard',
        )
        this.showBanner('bannerPerfectGuard', 1.0)
      } else {
        this.audio.playGuardBlock()
        this.guardStamina = Math.max(0, this.guardStamina - (attack === 'dark-beam' ? 38 : 26))
        const chipDamage = this.gameMode === 'practice' ? 0 : Math.max(2, Math.round(damage * 0.16))
        this.heroHp = Math.max(1, this.heroHp - chipDamage)
        this.totalHeroDamageTaken += chipDamage
        this.gainEnergy(10)
        this.score += 120
        this.addHitStop(0.035)
        this.addTrauma(0.22)
        this.effects.spawnBurst(shieldPos, 0x7dd3fc, 14, 22, 1.05)
        this.effects.spawnImpactRing(shieldPos, 0x38bdf8, 5.2)
        if (this.guardStamina <= 0) {
          this.guardBrokenCooldown = 1.6
          this.manualGuard = false
          this.hero.triggerAction('hit-heavy', 0.55)
          this.spawnFloatingAtWorld(
            new THREE.Vector3(this.hero.currentX, 14.5, this.hero.baseZ),
            'GUARD BROKEN!',
            '#fb923c',
            1.28,
            'crit',
          )
        } else {
          this.spawnFloatingAtWorld(
            new THREE.Vector3(this.hero.currentX, 14.4, this.hero.baseZ),
            `GUARD -${chipDamage}`,
            '#93c5fd',
            1.0,
            'guard',
          )
        }
      }
      this.emitHud()
      return
    }

    // 4. 英雄实打实受击（方向/重击分化 + 皮套闪红 + 试招靶场不致死）
    this.chainTimeLeft = 0
    this.punchChain = 0
    this.combo = 0
    const actualDmg = this.gameMode === 'practice' ? 0 : damage
    this.heroHp = Math.max(0, this.heroHp - actualDmg)
    this.totalHeroDamageTaken += actualDmg

    const hurtAction: HeroAction =
      attack === 'dark-beam' || attack === 'charge'
        ? 'hit-heavy'
        : attackX < this.hero.currentX - 0.6
          ? 'hit-left'
          : attackX > this.hero.currentX + 0.6
            ? 'hit-right'
            : 'hit'
    this.hero.triggerAction(hurtAction, hurtAction === 'hit-heavy' ? 0.54 : 0.4)
    this.hero.triggerHurtFlash(1)
    this.audio.playHeroHurt()
    this.addHitStop(0.075)
    this.addTrauma(0.56)
    this.triggerImpactFlash('hurt')

    const hurtPos = new THREE.Vector3(this.hero.currentX, 9.5, this.hero.baseZ - 1.2)
    this.effects.spawnBurst(hurtPos, 0xff4444, 18, 22, 1.12)
    this.effects.spawnImpactRing(hurtPos, 0xff8888, 5.8)
    this.effects.spawnHitFlash(hurtPos, 0xff8888, 1.2)
    this.effects.flashDynamicLight(hurtPos, 0xff3b30, 26, 0.28)
    this.spawnFloatingAtWorld(
      new THREE.Vector3(this.hero.currentX, 14.5, this.hero.baseZ),
      this.gameMode === 'practice' ? 'HIT!' : `-${actualDmg}`,
      '#ff4d4f',
      1.25,
    )

    if (this.heroHp <= 0 && this.gameMode !== 'practice') {
      this.phase = 'defeat'
      this.audio.setDangerAlarm(false)
      this.audio.setChargeHum(0)
      this.audio.setAmbience(this.arena.getTheme(), false)
      this.hero.triggerAction('defeat', 99)
      this.showBanner('bannerDefeat', 3.0)
    } else if (this.heroHp <= this.heroMaxHp * 0.3 && this.gameMode !== 'practice') {
      this.audio.setDangerAlarm(true)
    }
    this.emitHud()
  }

  private isHeroGuarding(): boolean {
    if (this.guardBrokenCooldown > 0) return false
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

  private computeBattleRankAndBadges(): { rank: BattleRank; badges: string[] } {
    const badges: string[] = []
    if (this.totalHeroDamageTaken === 0 && this.defeatedCount > 0) badges.push('badgeNoDamage')
    if (this.perfectGuards >= 2) badges.push('badgeParryMaster')
    if (this.perfectDodges >= 2) badges.push('badgePhantomDodge')
    if (this.maxCombo >= 12) badges.push('badgeComboKing')
    if (this.finisherKillCount >= 1) badges.push('badgeLightFinisher')

    let pts = 0
    if (this.heroHp >= 85) pts += 35
    else if (this.heroHp >= 55) pts += 22
    else pts += 10
    pts += Math.min(25, this.maxCombo * 1.8)
    pts += Math.min(25, (this.perfectGuards + this.perfectDodges) * 6)
    pts += Math.min(15, this.finisherKillCount * 8)

    const rank: BattleRank = pts >= 78 ? 'S' : pts >= 56 ? 'A' : pts >= 36 ? 'B' : 'C'
    return { rank, badges }
  }

  private loop = (now: number) => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.loop)

    const rawDt = Math.min(0.05, Math.max(0.001, (now - this.lastTimestamp) / 1000))
    this.lastTimestamp = now
    if (this.paused) return
    this.elapsedTime += rawDt

    // 分层顿帧与完美闪避子弹时间流速调度
    let dt = rawDt
    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - rawDt)
      dt = rawDt * 0.08
      // 顿帧冻结期间单独驱动怪兽高频肉体微抖，呈现拳拳到肉的扎实硬直震感！
      this.kaiju.stepHitstopVibration(rawDt)
    } else if (this.bulletTimeLeft > 0) {
      this.bulletTimeLeft = Math.max(0, this.bulletTimeLeft - rawDt)
      dt = rawDt * 0.28
    }

    this.stepSimulation(dt, rawDt, now)
    this.composer.render()
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    if (this.beamCooldown > 0) this.beamCooldown = Math.max(0, this.beamCooldown - dt)
    if (this.discCooldown > 0) this.discCooldown = Math.max(0, this.discCooldown - dt)
    if (this.punchCooldown > 0) this.punchCooldown = Math.max(0, this.punchCooldown - rawDt)
    if (this.kickCooldown > 0) this.kickCooldown = Math.max(0, this.kickCooldown - rawDt)
    if (this.manualJumpTimer > 0) this.manualJumpTimer = Math.max(0, this.manualJumpTimer - rawDt)
    if (this.counterBonusTimer > 0) {
      this.counterBonusTimer = Math.max(0, this.counterBonusTimer - rawDt)
    }
    if (this.guardBrokenCooldown > 0) {
      this.guardBrokenCooldown = Math.max(0, this.guardBrokenCooldown - rawDt)
    }
    if (this.menuFocusTimer > 0) {
      this.menuFocusTimer = Math.max(0, this.menuFocusTimer - rawDt)
      if (this.menuFocusTimer <= 0) this.menuOrbitFocus = 'center'
    }
    if (this.grappleSfxCooldown > 0) {
      this.grappleSfxCooldown = Math.max(0, this.grappleSfxCooldown - rawDt)
    }
    if (this.rainbowSfxCooldown > 0) {
      this.rainbowSfxCooldown = Math.max(0, this.rainbowSfxCooldown - rawDt)
    }
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

    // 消耗 160ms 输入缓冲队列
    if (this.bufferedInput && this.phase === 'fighting') {
      if (this.elapsedTime > this.bufferedInput.expiresAt) {
        this.bufferedInput = null
      } else if (this.tryExecuteInput(this.bufferedInput)) {
        this.bufferedInput = null
      }
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

    // 护盾耐力动态消耗与恢复
    if (guarding) {
      this.guardStamina = Math.max(0, this.guardStamina - rawDt * 20)
      if (this.guardStamina <= 0) {
        this.guardBrokenCooldown = 1.4
        this.manualGuard = false
      }
    } else {
      this.guardStamina = Math.min(100, this.guardStamina + rawDt * 30)
    }

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

    // 连续蓄力嗡鸣随蓄力进度平滑升降调
    const activeChargeLevel =
      this.phase === 'transform'
        ? this.transformProgress
        : this.battleStage === 'finisher-spread'
          ? this.finisherSpreadProgress
          : Math.max(this.gestureBeamCharge, this.gestureDiscCharge, this.gestureTypeCharge)
    this.audio.setChargeHum(activeChargeLevel)

    const dangerTimer =
      this.phase === 'fighting' &&
      this.gameMode !== 'practice' &&
      this.heroHp <= this.heroMaxHp * 0.3

    if (this.phase !== 'fighting') this.advanceEncounter(dt, false)
    this.kaiju.update(dt, this.elapsedTime, this.hero.currentX)

    const enforceCollision =
      this.phase === 'fighting' &&
      this.kaiju.root.visible &&
      this.kaiju.encounter.state !== 'dying' &&
      this.kaiju.encounter.state !== 'thrown'
    this.hero.setMinSafeWorldZ(
      enforceCollision ? this.kaiju.getFrontSurfaceZ() + 2.45 : -Infinity,
    )

    // 奥特曼头部实时死锁怪兽头部视线，彻底告别僵直目视空气！
    if (this.phase === 'fighting' && this.kaiju.root.visible) {
      this.hero.setLookTarget(this.kaiju.getTargetCenter('high'))
    } else {
      this.hero.setLookTarget(null)
    }

    this.hero.update(dt, this.elapsedTime, dangerTimer, nowMs, rawDt)
    this.arena.update(
      this.elapsedTime,
      this.hero.root.position,
      this.kaiju.root.position,
      this.kaiju.root.visible,
      this.camera.position,
      rawDt,
    )

    // 站位校准阶段（追踪稳定且站距合适 1.3s 自动完成，或 3.8s 保底放行，亦可随时跳过）
    if (this.phase === 'calibrating') {
      const good = this.gestureTracking && this.gestureDistanceHint === 'ok'
      const rate = good ? 0.82 : this.gestureTracking ? 0.38 : 0.12
      this.calibrationProgress = Math.min(1, this.calibrationProgress + rawDt * rate)
      if (this.calibrationProgress >= 1) {
        if (this.gameMode === 'practice') {
          void this.loadWave(this.waveIndex, true)
        } else {
          this.beginTransformPhase()
        }
      }
    } else if (this.phase === 'transform') {
      if (!this.transformBurstPlayed) {
        if (this.controlMode === 'keyboard') {
          this.transformProgress = Math.min(1, this.transformProgress + rawDt * 0.78)
          if (this.transformProgress >= 1) this.completeTransformBurst()
        }
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
        this.heroHp = Math.min(this.heroMaxHp, this.heroHp + 45)
        if (this.heroHp > this.heroMaxHp * 0.3) {
          this.audio.setDangerAlarm(false)
        }
        void this.loadWave(this.waveIndex + 1, false)
      }
    } else if (this.phase === 'fighting') {
      this.stepCombat(dt, rawDt)
    }

    // 同步拳脚真实骨骼动态拖尾丝带（高速出招段在拳/脚尖拉出流光气劲）
    const strikeInfo = this.hero.getStrikeContactInfo()
    const trailColor = this.heroProfile.accentColor
    this.effects.updateLimbTrail(
      'handL',
      strikeInfo.limb === 'handL' && strikeInfo.progress >= 0.12 && strikeInfo.progress <= 0.56,
      this.hero.getFistOrigin('left'),
      trailColor,
      rawDt,
    )
    this.effects.updateLimbTrail(
      'handR',
      strikeInfo.limb === 'handR' && strikeInfo.progress >= 0.12 && strikeInfo.progress <= 0.56,
      this.hero.getFistOrigin('right'),
      trailColor,
      rawDt,
    )
    this.effects.updateLimbTrail(
      'footL',
      strikeInfo.limb === 'footL' && strikeInfo.progress >= 0.12 && strikeInfo.progress <= 0.62,
      this.hero.getFootOrigin('left'),
      0xf97316,
      rawDt,
    )
    this.effects.updateLimbTrail(
      'footR',
      strikeInfo.limb === 'footR' && strikeInfo.progress >= 0.12 && strikeInfo.progress <= 0.62,
      this.hero.getFootOrigin('right'),
      0xf97316,
      rawDt,
    )

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
      this.camera.position,
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
    const warnTint =
      fight.attack === 'melee-high'
        ? 0xf59e0b
        : fight.attack === 'melee-low'
          ? 0x38bdf8
          : 0xff422a
    this.effects.updateWarningRing(
      isWarning,
      fight.attack === 'fireball' ? fight.targetX : this.hero.currentX,
      this.hero.baseZ,
      isWarning ? fight.time / WINDUP_TIME : 0,
      this.elapsedTime,
      warnTint,
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
    const spec = MONSTER_WAVES[this.waveIndex]!

    // 1. 真实物理接触帧近战结算（拳/脚进入 Active Hit Frame 瞬间引爆接触点！）
    if (this.pendingMeleeStrike && !this.pendingMeleeStrike.settled) {
      const info = this.hero.getStrikeContactInfo()
      if (info.active) {
        const st = this.pendingMeleeStrike
        st.settled = true
        this.pendingMeleeStrike = null

        const limbPos = st.isKick
          ? this.hero.getFootOrigin(st.side)
          : this.hero.getFistOrigin(st.side)
        const targetPos = this.kaiju.getTargetCenter(st.height)
        // 接触火花点精准落在拳/脚与怪兽表皮之间（70% 贴近怪兽面）
        const contactPos = limbPos.clone().lerp(targetPos, 0.58)
        const pan = st.side === 'left' ? -0.35 : 0.35

        this.gainEnergy(st.isFinisher ? 16 : 11)
        this.audio.playImpact(spec.armorMaterial, st.impact === 'heavy', this.combo + 1, pan)
        if (st.isFinisher && !st.isKick) {
          this.showBanner('bannerTriple', 0.9)
        }
        this.applyDamageToMonster(
          st.damage,
          st.color,
          st.isCritical,
          st.impact,
          st.side,
          st.height,
          contactPos,
        )
        if (this.phase !== 'fighting') return
      } else if (info.progress > 0.55 || info.limb === null) {
        this.pendingMeleeStrike = null
      }
    }

    // 2. 近身侧面角力 QTE
    if (this.battleStage === 'grapple') {
      this.grappleTimeLeft -= rawDt
      const camPush = this.controlMode === 'camera' ? this.gestureStrugglePower * 0.72 : 0
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

    if (this.battleStage === 'grapple-finish') {
      if (this.stageTimer >= 0.85 && this.hero.getAction() !== 'backflip-land') {
        this.hero.triggerAction('backflip-land', 1.15)
        this.audio.playFootstep(true)
      }
      if (this.stageTimer >= 2.05) {
        this.battleStage = 'melee'
        this.stageTimer = 0
        this.hero.setStageBaseZ(7.6, false)
        this.hero.setLeanRange(5.8)
        const safeKaijuZ = Math.min(-1.8, -(this.kaiju.frontExtentZ - 0.8))
        this.kaiju.setStageAnchor(safeKaijuZ, 7.6, null)
        this.kaiju.encounter.directorLocked = false
        this.kaiju.encounter.enter('stunned')
        this.emitHud()
      }
      return
    }

    // 3. 主动终结技：双臂展翼七彩聚能 -> 高空斜俯超级光线轰爆
    if (this.battleStage === 'finisher-spread') {
      const spreading =
        this.controlMode === 'camera' ? this.gestureSpreading : this.manualSpreadHeld
      const chargeSpeed = spreading ? 1.9 : 0.65
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

    if (this.battleStage === 'finisher-beam') {
      if (!this.finisherBeamFired) {
        this.finisherBeamWaitTimer += rawDt
        if (this.finisherBeamWaitTimer >= 2.1) {
          this.fireFinisherSuperBeam()
        }
      } else {
        this.addTrauma(0.14)
        this.finisherTickTimer -= rawDt
        if (this.finisherTickTimer <= 0) {
          this.finisherTickTimer = 0.28
          const hitPos = this.kaiju.getTargetCenter()
          this.spawnFloatingAtWorld(
            hitPos,
            `-${Math.round(105 * this.totalDamageMul)}!`,
            '#38e8ff',
            1.4,
            'crit',
          )
        }
        if (this.stageTimer >= 2.15) {
          this.monsterHp = 0
          this.onMonsterDefeated(true)
        }
      }
      return
    }

    // 4. 双光线对波结算
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

    // 5. 远程抛射物碰撞与空中消弹
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
          if (proj.kind === 'palm-bolt') {
            this.gainEnergy(10)
            this.audio.playImpact(spec.armorMaterial, false, this.combo + 1)
            this.applyDamageToMonster(proj.damage, '#67e8f9', false, 'light', proj.punchSide)
          } else if (proj.kind === 'kick-wave') {
            this.gainEnergy(16)
            this.audio.playImpact(spec.armorMaterial, true, this.combo + 1)
            this.applyDamageToMonster(proj.damage, '#fb923c', true, 'heavy')
          } else if (proj.kind === 'ultra-disc') {
            this.gainEnergy(18)
            this.audio.playImpact(spec.armorMaterial, true, this.combo + 1)
            if (this.kaiju.encounter.state === 'windup') {
              this.kaiju.encounter.enter('staggered')
              this.showBanner('bannerInterrupt', 1.0)
            }
            this.applyDamageToMonster(proj.damage, '#67e8f9', true, 'disc')
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
      undefined,
      1.0,
      this.gameMode === 'practice',
    )
    if (event === 'warn') {
      this.audio.playWarning()
      this.emitHud()
    } else if (event === 'illusion-start') {
      this.audio.playRoar('baltan')
      this.showBanner('bannerBaltanIllusion', 1.4)
      this.emitHud()
    } else if (event === 'absorb-start') {
      this.audio.playRoar('ganq')
      this.showBanner('bannerGanqAbsorb', 1.3)
      this.emitHud()
    } else if (event === 'absorb-release') {
      const dmg = spec.attackDamage + fight.absorbedCharge * 6
      this.effects.spawnKaijuFireball(
        this.kaiju.getAttackEmitOrigin(),
        new THREE.Vector3(this.hero.currentX, 8.8, this.hero.baseZ),
        0xc084fc,
        dmg,
        22,
      )
      this.audio.playBeam(false)
      fight.absorbedCharge = 0
    } else if (event === 'land' || event === 'roar' || event === 'collapse') {
      this.arena.groundImpact(this.kaiju.currentX, this.kaiju.currentZ, this.elapsedTime, 5.5)
      this.audio.playFootstep(true)
      this.addTrauma(event === 'roar' ? 0.34 : 0.45)
      if (event === 'roar') this.audio.playRoar()
    } else if (event === 'strike') {
      if (fight.attack === 'fireball') {
        this.effects.spawnKaijuFireball(
          this.kaiju.getAttackEmitOrigin(),
          new THREE.Vector3(fight.targetX, 8.8, this.hero.baseZ),
          spec.accentColor,
          spec.attackDamage,
          19,
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
    const portraitFactor = THREE.MathUtils.clamp((0.92 - this.viewportAspect) / 0.46, 0, 1)
    const targetCam = new THREE.Vector3()
    const targetLook = new THREE.Vector3()
    let desiredBaseFov = 46

    if (this.phase === 'menu') {
      const sway = Math.sin(this.elapsedTime * 0.52) * 0.6
      if (this.menuOrbitFocus === 'monster') {
        // 切换怪兽时按怪兽实际纵深自适应聚焦，避免巨型外壳（如加坦杰厄）贴近裁切相机近平面
        const depthPad = Math.max(0, this.kaiju.frontExtentZ - 3.6) * 2.4
        targetCam.set(5.2 + sway, 11.4 + depthPad * 0.25, 22.8 + depthPad + portraitFactor * 8)
        targetLook.set(0, 8.2, -3.2)
        desiredBaseFov = 44
      } else if (this.menuOrbitFocus === 'hero') {
        targetCam.set(3.2 + sway, 9.2, 23.8 + portraitFactor * 6)
        targetLook.set(0, 7.6, 11.4)
        desiredBaseFov = 42
      } else {
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
      }
    } else if (this.phase === 'calibrating' || this.phase === 'transform') {
      targetCam.set(
        Math.sin(this.elapsedTime * 0.8) * 1.1,
        THREE.MathUtils.lerp(8.8, 9.5, portraitFactor),
        THREE.MathUtils.lerp(27.6, 33.0, portraitFactor),
      )
      targetLook.set(0, THREE.MathUtils.lerp(8.2, 7.2, portraitFactor), 12.2)
      desiredBaseFov = 44
    } else if (this.phase === 'victory') {
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
    } else if (this.battleStage === 'grapple') {
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
      const camZ =
        THREE.MathUtils.lerp(0.6, 2.1, this.finisherSpreadProgress) - portraitFactor * 12.2
      targetCam.set(0, THREE.MathUtils.lerp(10.15, 9.6, portraitFactor), camZ)
      targetLook.set(0, THREE.MathUtils.lerp(9.85, 8.8, portraitFactor), 12.0)
      desiredBaseFov = THREE.MathUtils.lerp(44, 52, portraitFactor)
    } else if (this.battleStage === 'finisher-beam') {
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
    } else {
      // 贴身自由激斗低机位斜后特摄仰拍（子弹时间微推微旋增强慢镜电影感）
      const btZoom = this.bulletTimeLeft > 0 ? -1.8 : 0
      const sideOffset = THREE.MathUtils.lerp(1.8, 5.6, wideFactor)
      targetCam.set(
        this.hero.currentX * 0.48 + sideOffset,
        THREE.MathUtils.lerp(9.6, 10.6, portraitFactor),
        THREE.MathUtils.lerp(20.6, 26.2, portraitFactor) + btZoom,
      )
      targetLook.set(
        this.hero.currentX * 0.28 + this.kaiju.currentX * 0.16 - THREE.MathUtils.lerp(0.4, 0.1, portraitFactor),
        THREE.MathUtils.lerp(8.8, 7.4, portraitFactor),
        0.5,
      )
      desiredBaseFov = 46
    }

    const camRate =
      this.phase === 'menu'
        ? 4.2
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
    if (fight.state === 'illusion') return 'disc-illusion'
    if (fight.state === 'guarding') return 'kick-break'
    if (fight.state === 'windup' && !this.beamClashActive) {
      if (fight.attack === 'melee-high') return 'crouch-dodge'
      if (fight.attack === 'melee-low') return 'jump-dodge'
      if (fight.attack === 'fireball') return 'dodge-shoot'
      return 'guard'
    }
    if (this.isFinisherReady()) return 'beam-spread'
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
            : fight.attack === 'melee-high'
              ? 'warningMeleeHigh'
              : fight.attack === 'melee-low'
                ? 'warningMeleeLow'
                : fight.attack === 'charge'
                  ? 'warningCharge'
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
      chargeProgress = this.guardStamina / 100
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
    const { rank, badges } = this.computeBattleRankAndBadges()

    return {
      phase: this.phase,
      gameMode: this.gameMode,
      battleStage: this.battleStage,
      controlMode: this.controlMode,
      loadingProgress: this.loadingProgress,
      calibrationProgress: this.calibrationProgress,
      distanceHint: this.gestureDistanceHint,
      activeGestureCue: this.gestureActiveCue,
      heroId: this.heroProfile.id,
      heroForm: this.activeForm?.id ?? 'base',
      hasForms: !!this.heroProfile.forms,
      waveIndex: this.waveIndex,
      totalWaves: MONSTER_WAVES.length,
      activeTheme: this.arena.getTheme(),
      monsterId: spec.id,
      monsterHp: Math.round(this.monsterHp),
      monsterMaxHp: this.monsterMaxHp,
      monsterSpecialHintKey: fight.specialHintKey,
      heroHp: Math.round(this.heroHp),
      heroMaxHp: this.heroMaxHp,
      guardStamina: Math.round(this.guardStamina),
      energy: Math.round(this.energy),
      score: Math.round(this.score),
      punchChain: this.punchChain,
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfectGuards: this.perfectGuards,
      perfectDodges: this.perfectDodges,
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
      finisherReady: this.isFinisherReady(),
      finisherPhase,
      finisherProgress:
        finisherPhase === 'spread' ? this.finisherSpreadProgress : this.finisherBeamFired ? 1 : 0,
      actionGuide: this.resolveActionGuide(),
      activeSkillBannerKey: this.skillBannerKey,
      impactFlashKind: this.impactFlashKind,
      impactFlashSeq: this.impactFlashSeq,
      tracking: this.gestureTracking,
      bodyCoverage: this.gestureCoverage,
      mirroredCenterX: this.gestureMirroredX,
      poseHintKey: this.gestureHintKey,
      timerDanger:
        this.phase === 'fighting' &&
        this.gameMode !== 'practice' &&
        this.heroHp <= this.heroMaxHp * 0.3,
      battleRank: rank,
      badges,
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
