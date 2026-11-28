import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { UltraAudio } from './audio'
import { BattleEffects } from './effects'
import { ArenaManager } from './environment'
import { UltraGestureRecognizer } from './gesture'
import type { HandLandmarksInput } from './gesture'
import { HERO_PROFILES } from './heroes'
import type { HeroFormSpec, HeroId, HeroProfile } from './heroes'
import { HeroController } from './hero'
import { canTrackFeet, JumpKickRecognizer } from './jump'
import type {
  ConcreteSceneTheme,
  ControlMode,
  DistanceHint,
  FloatingDamageEvent,
  GestureActiveCue,
  HeroAction,
  PoseLandmark,
  PunchStyle,
} from './types'

export type PvpPhase = 'menu' | 'loading' | 'round-intro' | 'fighting' | 'round-ko' | 'match-over'
export type PvpSlot = 0 | 1

export interface PvpFighterHud {
  heroId: HeroId
  heroForm: string
  hasForms: boolean
  hp: number
  maxHp: number
  guardStamina: number
  energy: number
  combo: number
  maxCombo: number
  perfectGuards: number
  perfectDodges: number
  punchChain: number
  discCooldownRatio: number
  beamCooldownRatio: number
  chargeKind: 'beam' | 'disc' | 'guard' | 'type' | null
  chargeProgress: number
  incomingBeamAlert: boolean
  activeBannerKey: string | null
  impactFlashKind: 'none' | 'heavy' | 'parry' | 'dodge' | 'hurt'
  impactFlashSeq: number
  tracking: boolean
  bodyCoverage: 'none' | 'upper' | 'full'
  distanceHint: DistanceHint
  activeGestureCue: GestureActiveCue
  mirroredCenterX: number
  poseHintKey: string
  timerDanger: boolean
}

export interface PvpHudState {
  phase: PvpPhase
  controlMode: ControlMode
  loadingProgress: number
  activeTheme: ConcreteSceneTheme
  portraitSplit: boolean
  round: number
  maxRounds: number
  roundTimeLeft: number
  wins: [number, number]
  roundWinner: PvpSlot | 'draw' | null
  matchWinner: PvpSlot | null
  centerBannerKey: string | null
  beamClashActive: boolean
  beamClashBalance: number
  fighters: [PvpFighterHud, PvpFighterHud]
}

export interface PvpEngineCallbacks {
  onHudUpdate: (state: PvpHudState) => void
  onFloatingText: (slot: PvpSlot, evt: FloatingDamageEvent) => void
}

interface FighterRuntime {
  slot: PvpSlot
  sideSign: 1 | -1
  profile: HeroProfile
  formIndex: number
  hero: HeroController
  effects: BattleEffects
  gesture: UltraGestureRecognizer
  jump: JumpKickRecognizer
  feetTracked: boolean
  hp: number
  guardStamina: number
  guardBrokenCd: number
  energy: number
  combo: number
  maxCombo: number
  comboTimer: number
  perfectGuards: number
  perfectDodges: number
  punchChain: number
  manualCycle: number
  lastPunchSide: 'left' | 'right' | null
  chainTimeLeft: number
  discCooldown: number
  beamCooldown: number
  beamTicksRemaining: number
  beamTickTimer: number
  beamDamagePerTick: number
  beamIsSuper: boolean
  manualLean: -1 | 0 | 1
  manualGuard: boolean
  wasGuarding: boolean
  guardStartedAt: number
  gestureLean: number
  gestureGuard: boolean
  gestureTracking: boolean
  gestureCoverage: 'none' | 'upper' | 'full'
  gestureDistanceHint: DistanceHint
  gestureActiveCue: GestureActiveCue
  gestureMirroredX: number
  gestureHintKey: string
  gestureBeamCharge: number
  gestureBeamHolding: boolean
  gestureBeamArmSide: 'left' | 'right'
  gestureDiscCharge: number
  gestureDiscSide: 'left' | 'right' | null
  gestureTypeCharge: number
  bannerKey: string | null
  bannerTimer: number
  impactFlashKind: PvpFighterHud['impactFlashKind']
  impactFlashSeq: number
  shakeTrauma: number
  fovKick: number
  camAnchor: THREE.Vector3
  lookAnchor: THREE.Vector3
}

const PVP_MAX_HP = 150
const PVP_ROUND_SECONDS = 90
const DISC_BASE_CD = 1.45
const BEAM_BASE_CD = 2.0
const WINS_NEEDED = 2

/**
 * 第三人称 3D 同场双人分屏对战主引擎（并入电影级双视口 Bloom 后处理 + 1:1 真实格斗体感）：
 * - 双半屏独立 EffectComposer（RenderPass + UnrealBloomPass + OutputPass）合成，分屏照样复眼/光线辉光拉满
 * - 双方头部视线实时互锁 + 1:1 拳风招式（直拳/摆拳/上勾/手刀）+ 拳脚运动拖尾丝带
 * - 护盾耐力系统 + 精准弹反振开 + 侧闪完美躲避 + 空中消弹 + 双奥特曼宿命光线对波
 */
export class UltramanSplitPvpEngine {
  private readonly container: HTMLElement
  private readonly callbacks: PvpEngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly cameras: [THREE.PerspectiveCamera, THREE.PerspectiveCamera]
  private readonly loader = new GLTFLoader()

  // 双视口 Bloom 离屏后处理与最终分屏合成通道
  private readonly menuComposer: EffectComposer
  private readonly menuBloom: UnrealBloomPass
  private readonly splitComposers: [EffectComposer, EffectComposer]
  private readonly splitBlooms: [UnrealBloomPass, UnrealBloomPass]
  private readonly blitScene = new THREE.Scene()
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly blitMat: THREE.ShaderMaterial
  private readonly blitQuad: THREE.Mesh

  public readonly audio = new UltraAudio()
  private readonly arena: ArenaManager
  private readonly fighters: [FighterRuntime, FighterRuntime]

  private rafId = 0
  private lastTimestamp = 0
  private elapsedTime = 0
  private disposed = false
  private paused = false
  private baseAssets: Promise<void> | null = null
  private assetsReady = false

  private phase: PvpPhase = 'menu'
  private controlMode: ControlMode = 'camera'
  private activeTheme: ConcreteSceneTheme = 'city'
  private loadingProgress = 0
  private round = 1
  private roundTimeLeft = PVP_ROUND_SECONDS
  private wins: [number, number] = [0, 0]
  private roundWinner: PvpSlot | 'draw' | null = null
  private matchWinner: PvpSlot | null = null
  private phaseTimer = 0
  private centerBannerKey: string | null = null
  private centerBannerTimer = 0

  private beamClashActive = false
  private beamClashTimer = 0
  private beamClashBalance = 0.5

  private hitStopTimer = 0
  private floatingIdCounter = 1
  private floatSpread = [0, 0]
  private hudAccumulator = 0

  private fullWidth = 1280
  private fullHeight = 720
  private dpr = 1.15
  private portraitSplit = false
  private useBloom = true
  private smoothFrameMs = 16.7
  private slowFrameTime = 0
  private readonly tmpZeroVec = new THREE.Vector3()
  private readonly tmpOppEmit = new THREE.Vector3()
  private readonly tmpBeamMid = new THREE.Vector3()
  private readonly tmpTypePos = new THREE.Vector3()
  private readonly tmpLookOffset = new THREE.Vector3()
  private readonly tmpCamTarget = new THREE.Vector3()
  private readonly tmpLookTarget = new THREE.Vector3()
  private readonly resizeObserver: ResizeObserver

  constructor(container: HTMLElement, callbacks: PvpEngineCallbacks) {
    this.container = container
    this.callbacks = callbacks

    this.scene = new THREE.Scene()
    this.fullWidth = Math.max(2, container.clientWidth || window.innerWidth)
    this.fullHeight = Math.max(2, container.clientHeight || window.innerHeight)
    this.portraitSplit = this.fullHeight > this.fullWidth

    this.cameras = [
      new THREE.PerspectiveCamera(46, 1, 0.5, 450),
      new THREE.PerspectiveCamera(46, 1, 0.5, 450),
    ]

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    const isTouch =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window)
    this.dpr = Math.min(window.devicePixelRatio || 1, isTouch ? 1.05 : 1.15)
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(this.fullWidth, this.fullHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // 分屏两路相机共用同一帧动态阴影贴图，每帧只更新一次阴影，立省 50% 阴影开销
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.03

    container.appendChild(this.renderer.domElement)

    // 整备菜单半分辨率 Bloom 管线
    this.menuComposer = new EffectComposer(this.renderer)
    this.menuComposer.setPixelRatio(this.dpr)
    this.menuComposer.setSize(this.fullWidth, this.fullHeight)
    this.menuComposer.addPass(new RenderPass(this.scene, this.cameras[0]))
    this.menuBloom = new UnrealBloomPass(
      new THREE.Vector2(
        Math.max(1, Math.floor(this.fullWidth * 0.5)),
        Math.max(1, Math.floor(this.fullHeight * 0.5)),
      ),
      0.2,
      0.2,
      0.98,
    )
    this.menuComposer.addPass(this.menuBloom)
    this.menuComposer.addPass(new OutputPass())

    // 分屏双路独立半分辨率 Bloom 管线
    const makeSplitComposer = (cam: THREE.PerspectiveCamera) => {
      const sw = Math.max(2, Math.floor(this.fullWidth * 0.5))
      const sh = Math.max(2, this.fullHeight)
      const comp = new EffectComposer(this.renderer)
      comp.renderToScreen = false
      comp.setPixelRatio(this.dpr)
      comp.setSize(sw, sh)
      comp.addPass(new RenderPass(this.scene, cam))
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(Math.max(1, Math.floor(sw * 0.5)), Math.max(1, Math.floor(sh * 0.5))),
        0.18,
        0.2,
        1.02,
      )
      comp.addPass(bloom)
      comp.addPass(new OutputPass())
      return { comp, bloom }
    }
    const sc0 = makeSplitComposer(this.cameras[0])
    const sc1 = makeSplitComposer(this.cameras[1])
    this.splitComposers = [sc0.comp, sc1.comp]
    this.splitBlooms = [sc0.bloom, sc1.bloom]

    // 离屏 splitComposers 已由 OutputPass 完成 ACES 色调映射与 sRGB 编码，此处用直通 Shader 原样拷贝，避免 MeshBasicMaterial 二次 sRGB 伽马提亮泛白
    this.blitMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null as THREE.Texture | null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uMap, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat)
    this.blitScene.add(this.blitQuad)

    this.arena = new ArenaManager(this.scene, this.renderer)
    this.fighters = [
      this.createFighterRuntime(0, 1, HERO_PROFILES.tiga),
      this.createFighterRuntime(1, -1, HERO_PROFILES.zero),
    ]

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)
    this.handleResize()

    this.lastTimestamp = performance.now()
    this.loop(this.lastTimestamp)
  }

  private createFighterRuntime(
    slot: PvpSlot,
    sideSign: 1 | -1,
    profile: HeroProfile,
  ): FighterRuntime {
    return {
      slot,
      sideSign,
      profile,
      formIndex: 0,
      hero: new HeroController(this.scene, { sideSign, baseZ: 8.4 }),
      effects: new BattleEffects(this.scene),
      gesture: new UltraGestureRecognizer(),
      jump: new JumpKickRecognizer(),
      feetTracked: false,
      hp: PVP_MAX_HP,
      guardStamina: 100,
      guardBrokenCd: 0,
      energy: 45,
      combo: 0,
      maxCombo: 0,
      comboTimer: 0,
      perfectGuards: 0,
      perfectDodges: 0,
      punchChain: 0,
      manualCycle: 0,
      lastPunchSide: null,
      chainTimeLeft: 0,
      discCooldown: 0,
      beamCooldown: 0,
      beamTicksRemaining: 0,
      beamTickTimer: 0,
      beamDamagePerTick: 22,
      beamIsSuper: false,
      manualLean: 0,
      manualGuard: false,
      wasGuarding: false,
      guardStartedAt: -Infinity,
      gestureLean: 0,
      gestureGuard: false,
      gestureTracking: false,
      gestureCoverage: 'none',
      gestureDistanceHint: 'ok',
      gestureActiveCue: 'none',
      gestureMirroredX: slot === 0 ? 0.25 : 0.75,
      gestureHintKey: 'hintStandCenter',
      gestureBeamCharge: 0,
      gestureBeamHolding: false,
      gestureBeamArmSide: 'right',
      gestureDiscCharge: 0,
      gestureDiscSide: null,
      gestureTypeCharge: 0,
      bannerKey: null,
      bannerTimer: 0,
      impactFlashKind: 'none',
      impactFlashSeq: 0,
      shakeTrauma: 0,
      fovKick: 0,
      camAnchor: new THREE.Vector3(sideSign * 2.5, 11.8, sideSign * 21.5),
      lookAnchor: new THREE.Vector3(0, 8.6, -sideSign * 8.4),
    }
  }

  private handleResize() {
    if (this.disposed) return
    this.fullWidth = Math.max(2, this.container.clientWidth || window.innerWidth)
    this.fullHeight = Math.max(2, this.container.clientHeight || window.innerHeight)
    this.portraitSplit = this.fullHeight > this.fullWidth
    this.renderer.setSize(this.fullWidth, this.fullHeight)

    this.menuComposer.setSize(this.fullWidth, this.fullHeight)
    this.menuBloom.setSize(
      Math.max(1, Math.floor(this.fullWidth * 0.5)),
      Math.max(1, Math.floor(this.fullHeight * 0.5)),
    )

    const sw = this.portraitSplit ? this.fullWidth : Math.max(2, Math.floor(this.fullWidth * 0.5))
    const sh = this.portraitSplit ? Math.max(2, Math.floor(this.fullHeight * 0.5)) : this.fullHeight
    for (let i = 0; i < 2; i++) {
      this.splitComposers[i]!.setSize(sw, sh)
      this.splitBlooms[i]!.setSize(Math.max(1, Math.floor(sw * 0.5)), Math.max(1, Math.floor(sh * 0.5)))
    }
  }

  private getSlotAspect(): number {
    if (this.phase === 'menu') {
      return this.fullWidth / this.fullHeight
    }
    if (this.portraitSplit) {
      return this.fullWidth / Math.max(1, this.fullHeight * 0.5)
    }
    return Math.max(1, this.fullWidth * 0.5) / this.fullHeight
  }

  public preloadBaseAssets(): Promise<void> {
    this.baseAssets ??= this.loadBaseAssets().catch((err) => {
      this.baseAssets = null
      throw err
    })
    return this.baseAssets
  }

  private async loadBaseAssets() {
    this.loadingProgress = 15
    this.emitHud()
    await Promise.all([
      this.arena.setTheme(this.activeTheme),
      this.fighters[0].hero.load(this.loader, this.fighters[0].profile),
      this.fighters[1].hero.load(this.loader, this.fighters[1].profile),
    ])
    if (this.disposed) return
    this.applyFighterForm(0)
    this.applyFighterForm(1)
    this.fighters[0].hero.triggerAction('pose-intro', 0.85)
    this.fighters[1].hero.triggerAction('pose-intro', 0.85)
    this.loadingProgress = 100
    this.assetsReady = true
    this.emitHud()
  }

  public async setHero(slot: PvpSlot, heroId: HeroId): Promise<void> {
    const f = this.fighters[slot]
    const profile = HERO_PROFILES[heroId]
    if (f.profile.id === profile.id) return
    f.profile = profile
    f.formIndex = 0
    this.applyFighterForm(slot)
    this.emitHud()
    if (!this.assetsReady) return
    await f.hero.load(this.loader, profile)
    if (this.disposed || f.profile !== profile) return
    f.hero.resetPose()
    this.applyFighterForm(slot)
    f.hero.triggerAction('pose-intro', 0.85)
    const burstPos = f.hero.root.position.clone().add(new THREE.Vector3(0, 9.2, 0))
    f.effects.spawnBurst(burstPos, profile.accentColor, 18, 18, 1.1)
    f.effects.spawnImpactRing(burstPos, profile.accentColor, 5.2)
    this.emitHud()
  }

  public async setSceneTheme(theme: ConcreteSceneTheme): Promise<void> {
    this.activeTheme = theme
    await this.arena.setTheme(theme)
    this.emitHud()
  }

  public previewNextForm(slot: PvpSlot) {
    const f = this.fighters[slot]
    if (!f.profile.forms) return
    f.formIndex = (f.formIndex + 1) % f.profile.forms.length
    const form = this.getActiveForm(slot)!
    this.applyFighterForm(slot)
    f.hero.triggerAction('pose-intro', 0.7)
    const pos = f.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, 0))
    f.effects.spawnBurst(pos, form.accentColor, 20, 20, 1.2)
    f.effects.spawnImpactRing(pos, form.accentColor, 5.8)
    this.audio.playTransform('type')
    this.emitHud()
  }

  public setControlMode(mode: ControlMode) {
    this.controlMode = mode
    this.emitHud()
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
    if (muted) {
      this.audio.setDangerAlarm(false)
      this.audio.setAmbience(this.activeTheme, false)
    } else if (this.phase === 'fighting') {
      this.audio.setAmbience(this.activeTheme, true)
    }
  }

  public setPaused(paused: boolean) {
    this.paused = paused
    this.syncDangerAlarm()
  }

  public resetTracking() {
    for (const f of this.fighters) {
      f.feetTracked = false
      f.jump.reset()
      f.gesture.reset()
    }
  }

  public recenter() {
    for (const f of this.fighters) {
      f.gesture.recenter()
      f.jump.reset()
    }
  }

  private getActiveForm(slot: PvpSlot): HeroFormSpec | null {
    const f = this.fighters[slot]
    return f.profile.forms?.[f.formIndex] ?? null
  }

  private getDamageMul(slot: PvpSlot): number {
    const f = this.fighters[slot]
    return f.profile.baseDamageMul * (this.getActiveForm(slot)?.damageMul ?? 1)
  }

  private getEnergyMul(slot: PvpSlot): number {
    const f = this.fighters[slot]
    return f.profile.baseEnergyGainMul * (this.getActiveForm(slot)?.energyGainMul ?? 1)
  }

  private gainEnergy(slot: PvpSlot, base: number) {
    const f = this.fighters[slot]
    f.energy = Math.min(100, f.energy + base * this.getEnergyMul(slot))
  }

  private triggerSlotFlash(slot: PvpSlot, kind: PvpFighterHud['impactFlashKind']) {
    const f = this.fighters[slot]
    f.impactFlashKind = kind
    f.impactFlashSeq++
  }

  private applyFighterForm(slot: PvpSlot) {
    const f = this.fighters[slot]
    const form = this.getActiveForm(slot)
    f.hero.setForm(form)
    f.effects.setHeroTheme(
      form
        ? {
            ...f.profile,
            accentColor: form.accentColor,
            beamColor: form.beamColor,
            beamSuperColor: form.beamSuperColor,
            discColor: form.discColor,
            burstColor: form.burstColor,
          }
        : f.profile,
    )
  }

  public async startMatch(mode: ControlMode, theme = this.activeTheme): Promise<void> {
    this.controlMode = mode
    this.activeTheme = theme
    this.audio.unlock()
    this.resetTracking()

    this.phase = 'loading'
    this.loadingProgress = this.assetsReady ? 65 : 15
    this.emitHud()

    if (!this.assetsReady) {
      await this.preloadBaseAssets()
    }
    if (this.disposed) return

    await Promise.all([
      this.arena.setTheme(theme),
      this.fighters[0].hero.load(this.loader, this.fighters[0].profile),
      this.fighters[1].hero.load(this.loader, this.fighters[1].profile),
    ])
    if (this.disposed) return

    this.wins = [0, 0]
    this.round = 1
    this.matchWinner = null
    this.roundWinner = null
    for (const slot of [0, 1] as const) {
      this.fighters[slot].maxCombo = 0
      this.fighters[slot].perfectGuards = 0
      this.fighters[slot].perfectDodges = 0
    }
    this.audio.playTransform('rise')
    this.audio.setAmbience(theme, true)
    this.beginRound(1)
  }

  private beginRound(roundNum: number) {
    this.round = roundNum
    this.roundTimeLeft = PVP_ROUND_SECONDS
    this.roundWinner = null
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.beamClashBalance = 0.5

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      f.effects.clearAllDynamic()
      f.hp = PVP_MAX_HP
      f.guardStamina = 100
      f.guardBrokenCd = 0
      f.energy = 45
      f.combo = 0
      f.comboTimer = 0
      f.punchChain = 0
      f.manualCycle = 0
      f.chainTimeLeft = 0
      f.discCooldown = 0
      f.beamCooldown = 0
      f.beamTicksRemaining = 0
      f.manualLean = 0
      f.manualGuard = false
      f.wasGuarding = false
      f.guardStartedAt = -Infinity
      f.gestureLean = 0
      f.gestureGuard = false
      f.gestureBeamCharge = 0
      f.gestureBeamHolding = false
      f.gestureDiscCharge = 0
      f.gestureTypeCharge = 0
      f.bannerKey = null
      f.bannerTimer = 0
      this.applyFighterForm(slot)
      f.hero.resetPose()
      f.hero.triggerAction('pose-intro', 1.0)
    }

    this.phase = 'round-intro'
    this.phaseTimer = 1.45
    this.showCenterBanner(roundNum >= 3 ? 'bannerPvpFinalRound' : 'bannerPvpRoundStart', 1.4)
    this.syncDangerAlarm()
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.audio.setDangerAlarm(false)
    this.audio.setAmbience(this.activeTheme, false)
    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      f.effects.clearAllDynamic()
      f.hero.resetPose()
      f.hero.setLookTarget(null)
      f.hero.triggerAction('pose-intro', 0.85)
    }
    this.emitHud()
  }

  public feedPlayerPose(
    slot: PvpSlot,
    landmarks: PoseLandmark[] | null,
    worldLandmarks: PoseLandmark[] | null,
    now: number,
    width: number,
    height: number,
    laneCenter: number,
    hands?: HandLandmarksInput | null,
  ) {
    if (this.controlMode !== 'camera') return
    const f = this.fighters[slot]
    const snap = f.gesture.update(
      landmarks,
      now,
      width,
      height,
      worldLandmarks,
      !!f.profile.forms,
      laneCenter,
      hands,
    )
    f.gestureTracking = snap.tracking
    const fullBody = snap.coverage === 'full' && canTrackFeet(landmarks)
    const physicalKick = fullBody && f.feetTracked ? snap.kick : null
    f.feetTracked = fullBody
    f.gestureCoverage = fullBody ? 'full' : snap.tracking ? 'upper' : 'none'
    f.gestureDistanceHint = snap.distanceHint
    f.gestureActiveCue = snap.activeCue
    f.gestureMirroredX = snap.mirroredCenterX
    f.gestureLean = snap.lean
    f.gestureGuard = snap.guard && f.guardBrokenCd <= 0
    if (snap.guardJustStarted && f.guardBrokenCd <= 0) {
      f.guardStartedAt = this.elapsedTime
    }
    f.gestureBeamCharge = snap.beamCharge
    f.gestureBeamHolding = snap.beamHolding
    f.gestureBeamArmSide = snap.beamArmSide
    f.gestureDiscCharge = snap.discCharge
    f.gestureDiscSide = snap.discSide
    f.gestureTypeCharge = snap.typeCharge
    f.gestureHintKey =
      !physicalKick && snap.hintKey === 'hintKick' ? 'hintReady' : snap.hintKey
    if (snap.livePose && !fullBody) snap.livePose.coverage = 'upper'

    f.hero.setLiveBodyPose(snap.livePose, now)

    if (this.phase !== 'fighting') return

    if (this.beamClashActive) {
      if (snap.punch || physicalKick) {
        this.pushBeamClash(slot, 0.1)
      }
      return
    }

    const jumped = f.jump.update(
      !fullBody && snap.tracking ? landmarks : null,
      now,
      width / height,
    )
    if (jumped) {
      this.executeKick(slot, 'right', true, true)
    } else if (snap.typeTrigger) {
      this.switchFormInBattle(slot)
    } else if (snap.beamTrigger) {
      this.executeBeam(slot)
    } else if (snap.discTrigger) {
      this.executeDisc(slot, snap.discTrigger)
    } else if (physicalKick) {
      this.executeKick(slot, physicalKick, false, true)
    } else if (snap.punch) {
      this.executePunch(slot, snap.punch, snap.punchStyle, snap.punchPower, true)
    }
  }

  public setManualLean(slot: PvpSlot, dir: -1 | 0 | 1) {
    this.fighters[slot].manualLean = dir
  }

  public setManualGuard(slot: PvpSlot, active: boolean) {
    const f = this.fighters[slot]
    if (active && f.guardBrokenCd > 0) return
    if (active && !f.manualGuard) {
      f.guardStartedAt = this.elapsedTime
    }
    f.manualGuard = active
  }

  public triggerManualPunch(slot: PvpSlot, side: 'left' | 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.pushBeamClash(slot, 0.095)
      return
    }
    const f = this.fighters[slot]
    const styles: PunchStyle[] = ['jab', 'hook', 'chop', 'uppercut']
    const style = styles[f.manualCycle++ % styles.length]!
    this.executePunch(slot, side, style, style === 'uppercut' || style === 'hook' ? 0.9 : 0.72)
  }

  public triggerManualKick(slot: PvpSlot, side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.pushBeamClash(slot, 0.105)
      return
    }
    this.executeKick(slot, side, false)
  }

  public triggerManualDisc(slot: PvpSlot, side: 'left' | 'right' = 'right') {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.pushBeamClash(slot, 0.105)
      return
    }
    this.executeDisc(slot, side)
  }

  public triggerManualBeam(slot: PvpSlot) {
    if (this.phase !== 'fighting') return
    if (this.beamClashActive) {
      this.pushBeamClash(slot, 0.115)
      return
    }
    this.executeBeam(slot)
  }

  public triggerManualTypeSwitch(slot: PvpSlot) {
    if (this.phase === 'menu') {
      this.previewNextForm(slot)
      return
    }
    if (this.phase !== 'fighting' || this.beamClashActive) return
    this.switchFormInBattle(slot)
  }

  private switchFormInBattle(slot: PvpSlot) {
    const f = this.fighters[slot]
    if (!f.profile.forms) return
    f.formIndex = (f.formIndex + 1) % f.profile.forms.length
    const form = this.getActiveForm(slot)!
    this.applyFighterForm(slot)

    const pos = f.hero.root.position.clone().add(new THREE.Vector3(0, 9.5, 0))
    f.effects.spawnBurst(pos, form.accentColor, 26, 24, 1.4)
    f.effects.spawnHitFlash(pos, form.accentColor, 1.5)
    f.effects.spawnImpactRing(pos, form.accentColor, 7.0)
    f.effects.flashDynamicLight(pos, form.accentColor, 26, 0.3)
    this.audio.playTransform('type')
    this.addTrauma(slot, 0.3)
    f.fovKick = -3.0
    this.showFighterBanner(slot, `bannerForm${form.bannerKey}`, 1.25)
    this.emitHud()
  }

  private executePunch(
    slot: PvpSlot,
    side: 'left' | 'right',
    style: PunchStyle = 'jab',
    power = 0.75,
    instant = false,
  ) {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    if (f.effects.isHeroBeamActive()) return

    f.punchChain = f.chainTimeLeft > 0 && f.lastPunchSide !== side ? f.punchChain + 1 : 1
    const finisher = f.punchChain >= 3 || style === 'uppercut'
    f.lastPunchSide = side
    f.chainTimeLeft = finisher ? 0 : 1.5

    const action: HeroAction =
      style === 'uppercut'
        ? side === 'left'
          ? 'uppercut-left'
          : 'uppercut-right'
        : style === 'hook'
          ? side === 'left'
            ? 'hook-left'
            : 'hook-right'
          : style === 'chop'
            ? side === 'left'
              ? 'chop-left'
              : 'chop-right'
            : finisher
              ? 'punch-heavy'
              : side === 'left'
                ? 'punch-left'
                : 'punch-right'

    const baseDur = finisher ? 0.4 : 0.3
    f.hero.triggerAction(action, instant ? baseDur * 0.78 : baseDur, instant)
    if (finisher) f.fovKick = -2.4

    const origin = f.hero.getFistOrigin(side)
    const target = opp.hero.getTargetCenter()
    const baseDmg = style === 'uppercut' ? 24 : style === 'hook' || style === 'chop' ? 18 : finisher ? 25 : 13
    const damage = Math.round(baseDmg * (0.85 + power * 0.25) * this.getDamageMul(slot))
    f.effects.spawnPalmBolt(origin, target, damage, side)
    f.effects.spawnMeleeSlash(
      origin,
      finisher ? 0xfacc15 : f.profile.burstColor,
      [0.2, 0, side === 'left' ? -0.5 : 2.5],
      finisher ? 1.15 : 0.9,
      side === 'left' ? -1 : 1,
    )
    f.effects.spawnBurst(origin, f.profile.burstColor, 8, 16, 0.65)
    this.audio.playSwing(side, false)
    if (finisher) f.punchChain = 0
    this.emitHud()
  }

  private executeKick(slot: PvpSlot, side: 'left' | 'right', jumping: boolean, instant = false) {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    if (f.effects.isHeroBeamActive()) return

    const dur = jumping ? (instant ? 0.38 : 0.48) : instant ? 0.3 : 0.38
    f.hero.triggerAction(
      jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right',
      dur,
      instant,
    )
    f.fovKick = jumping ? -3.2 : -2.2
    const origin = f.hero.getFootOrigin(side)
    const target = opp.hero.getTargetCenter()
    const damage = Math.round((jumping ? 28 : 22) * this.getDamageMul(slot))
    f.effects.spawnKickWave(origin, target, damage)
    f.effects.spawnBurst(origin, 0xf97316, 12, 18, 0.85)
    this.audio.playSwing(side, true)
    this.showFighterBanner(slot, jumping ? 'bannerJumpKick' : 'bannerKick', 0.85)
  }

  private executeDisc(slot: PvpSlot, side: 'left' | 'right') {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    if (f.effects.isHeroBeamActive() || f.discCooldown > 0) return

    const cdMul = this.getActiveForm(slot)?.discCooldownMul ?? 1
    f.discCooldown = DISC_BASE_CD * cdMul
    f.hero.setDiscCharge(0, side)
    f.hero.triggerAction('disc', 0.42)
    const origin = f.hero.getDiscOrigin(side)
    const target = opp.hero.getTargetCenter()
    f.effects.spawnUltraDisc(origin, target, Math.round(28 * this.getDamageMul(slot)))
    this.audio.playDisc()
    this.showFighterBanner(slot, `bannerDisc${f.profile.bannerKey}`, 0.95)
    this.emitHud()
  }

  private executeBeam(slot: PvpSlot) {
    const f = this.fighters[slot]
    const oppSlot = (1 - slot) as PvpSlot
    const opp = this.fighters[oppSlot]
    if (f.effects.isHeroBeamActive() || f.beamCooldown > 0) return
    if (f.energy < 35) {
      this.spawnFloating(
        slot,
        f.hero.root.position.clone().add(new THREE.Vector3(0, 14, 0)),
        'ENERGY LOW!',
        '#facc15',
        0.95,
      )
      return
    }

    const isSuper = f.energy >= 100
    f.energy = Math.max(0, f.energy - (isSuper ? 100 : 35))
    f.beamCooldown = BEAM_BASE_CD
    f.beamIsSuper = isSuper

    if (opp.effects.isHeroBeamActive()) {
      this.startPvpBeamClash(slot, isSuper)
      return
    }

    const dur = isSuper ? 1.65 : 1.25
    f.hero.triggerAction('beam', dur)
    f.effects.startHeroBeam(isSuper, dur)
    f.effects.flashDynamicLight(
      f.hero.root.position.clone().add(new THREE.Vector3(0, 9.2, 0)),
      isSuper ? f.profile.beamSuperColor : f.profile.beamColor,
      36,
      0.4,
    )
    this.audio.playBeam(isSuper)
    this.addTrauma(slot, isSuper ? 0.55 : 0.38)
    this.addTrauma(oppSlot, 0.25)
    f.fovKick = isSuper ? -4.0 : -2.8

    f.beamTicksRemaining = isSuper ? 4 : 3
    f.beamDamagePerTick = Math.round((isSuper ? 16 : 13) * this.getDamageMul(slot))
    f.beamTickTimer = 0.38

    this.showFighterBanner(
      slot,
      isSuper ? `bannerSuperBeam${f.profile.bannerKey}` : `bannerBeam${f.profile.bannerKey}`,
      dur,
    )
    this.emitHud()
  }

  private startPvpBeamClash(responderSlot: PvpSlot, responderSuper: boolean) {
    const initiatorSlot = (1 - responderSlot) as PvpSlot
    const initiatorSuper = this.fighters[initiatorSlot].beamIsSuper

    this.beamClashActive = true
    this.beamClashTimer = 1.85
    let balance = 0.5
    if (initiatorSuper !== responderSuper) {
      const bonus = 0.12
      balance += (initiatorSlot === 0 ? 1 : -1) * (initiatorSuper ? bonus : -bonus)
    }
    this.beamClashBalance = THREE.MathUtils.clamp(balance, 0.2, 0.8)

    for (const s of [0, 1] as const) {
      const f = this.fighters[s]
      f.beamTicksRemaining = 0
      f.hero.triggerAction('beam', 2.0)
      f.effects.startHeroBeam(f.beamIsSuper, 2.0)
      this.addTrauma(s, 0.55)
      f.fovKick = -3.8
    }
    this.syncBeamClashVisuals()
    this.audio.playBeam(responderSuper)
    this.audio.playBeamClash()
    this.showCenterBanner('bannerBeamClash', 1.85)
    this.emitHud()
  }

  private syncBeamClashVisuals() {
    // 双人 PvP 对波时双方各自渲染自己的 heroBeam：禁用冗余的怪兽暗黑光线，且全场景仅保留一份中心奇点球
    this.fighters[0].effects.setBeamClash(this.beamClashActive, this.beamClashBalance, {
      showCounterBeam: false,
      showClashPoint: true,
    })
    this.fighters[1].effects.setBeamClash(this.beamClashActive, 1 - this.beamClashBalance, {
      showCounterBeam: false,
      showClashPoint: false,
    })
  }

  private pushBeamClash(slot: PvpSlot, amount: number) {
    if (!this.beamClashActive) return
    const dir = slot === 0 ? 1 : -1
    this.beamClashBalance = THREE.MathUtils.clamp(this.beamClashBalance + dir * amount, 0, 1)
    this.syncBeamClashVisuals()
    this.addTrauma(0, 0.14)
    this.addTrauma(1, 0.14)
    this.audio.playPunch(false)
    this.emitHud()
  }

  private resolvePvpBeamClash() {
    this.beamClashActive = false
    this.beamClashTimer = 0
    this.fighters[0].effects.setBeamClash(false, 0.5)
    this.fighters[1].effects.setBeamClash(false, 0.5)
    this.fighters[0].effects.stopHeroBeam()
    this.fighters[1].effects.stopHeroBeam()

    const winnerSlot: PvpSlot = this.beamClashBalance >= 0.5 ? 0 : 1
    const loserSlot = (1 - winnerSlot) as PvpSlot
    const loser = this.fighters[loserSlot]
    const hitPos = loser.hero.getTargetCenter()

    loser.effects.spawnBurst(hitPos, 0xfef08a, 34, 32, 1.55)
    loser.effects.spawnDebris(hitPos, 16, 22)
    loser.effects.spawnImpactRing(hitPos, 0xfacc15, 10.5)
    loser.effects.spawnHitFlash(hitPos, 0xffffff, 2.0)
    loser.effects.flashDynamicLight(hitPos, 0xfef08a, 46, 0.45)
    this.arena.groundImpact(loser.hero.currentX, loser.hero.worldZ, this.elapsedTime, 9.0)
    this.audio.playHeavyImpact()
    this.audio.playExplosion()
    this.gainEnergy(winnerSlot, 22)
    this.showCenterBanner('bannerClashWin', 1.2)

    this.inflictDamage(
      winnerSlot,
      loserSlot,
      Math.round(54 * this.getDamageMul(winnerSlot)),
      '#fef08a',
      true,
      true,
    )
  }

  private isFighterGuarding(slot: PvpSlot): boolean {
    const f = this.fighters[slot]
    if (f.guardBrokenCd > 0) return false
    return f.manualGuard || f.gestureGuard
  }

  private inflictDamage(
    attackerSlot: PvpSlot,
    defenderSlot: PvpSlot,
    rawDamage: number,
    color: string,
    isHeavy: boolean,
    unblockable = false,
  ) {
    if (this.phase !== 'fighting') return
    const atk = this.fighters[attackerSlot]
    const def = this.fighters[defenderSlot]
    const hitPos = def.hero.getTargetCenter()

    if (!unblockable && this.isFighterGuarding(defenderSlot)) {
      const isJustGuard = this.elapsedTime - def.guardStartedAt <= 0.52
      if (isJustGuard) {
        def.perfectGuards += 1
        def.guardStamina = 100
        this.gainEnergy(defenderSlot, 28)
        def.hero.triggerAction('guard-parry', 0.42)
        this.audio.playParry()
        def.effects.triggerShieldBlockFlash()
        def.effects.spawnBurst(hitPos, 0xfef08a, 24, 24, 1.15)
        def.effects.spawnImpactRing(hitPos, 0xfef08a, 7.0)
        def.effects.flashDynamicLight(hitPos, 0xfef08a, 32, 0.28)
        this.addHitStop(0.068)
        this.addTrauma(defenderSlot, 0.28)
        this.addTrauma(attackerSlot, 0.28)
        this.triggerSlotFlash(defenderSlot, 'parry')
        this.spawnFloating(defenderSlot, hitPos, 'PARRY!', '#38bdf8', 1.28, 'guard')
        this.spawnFloating(attackerSlot, hitPos, 'PARRIED!', '#38bdf8', 1.14, 'guard')
        this.showFighterBanner(defenderSlot, 'bannerPerfectGuard', 0.9)
        this.emitHud()
        return
      }

      if (isHeavy && atk.hero.getAction().includes('kick')) {
        def.manualGuard = false
        def.gestureGuard = false
        def.guardStamina = 0
        def.guardBrokenCd = 1.5
        this.audio.playHeavyImpact()
        this.triggerSlotFlash(defenderSlot, 'hurt')
        this.spawnFloating(defenderSlot, hitPos, 'GUARD BREAK!', '#fb923c', 1.26, 'crit')
      } else {
        def.guardStamina = Math.max(0, def.guardStamina - (isHeavy ? 32 : 20))
        const chip = Math.max(2, Math.round(rawDamage * 0.2))
        def.hp = Math.max(1, def.hp - chip)
        this.gainEnergy(defenderSlot, 9)
        this.audio.playGuardBlock()
        def.effects.triggerShieldBlockFlash()
        def.effects.spawnBurst(hitPos, 0x7dd3fc, 12, 18, 0.9)
        if (def.guardStamina <= 0) {
          def.guardBrokenCd = 1.4
          def.manualGuard = false
        }
        this.spawnFloating(defenderSlot, hitPos, `GUARD -${chip}`, '#93c5fd', 0.98, 'guard')
        this.spawnFloating(attackerSlot, hitPos, `-${chip}`, '#93c5fd', 0.95)
        this.emitHud()
        return
      }
    }

    def.hp = Math.max(0, def.hp - rawDamage)
    def.combo = 0
    def.punchChain = 0
    def.chainTimeLeft = 0
    atk.combo += 1
    atk.maxCombo = Math.max(atk.maxCombo, atk.combo)
    atk.comboTimer = 3.2

    def.hero.triggerAction(isHeavy ? 'hit-heavy' : 'hit', isHeavy ? 0.48 : 0.36)
    def.hero.triggerHurtFlash(isHeavy ? 1 : 0.78)
    this.triggerSlotFlash(defenderSlot, 'hurt')
    if (isHeavy) this.triggerSlotFlash(attackerSlot, 'heavy')

    def.effects.spawnBurst(
      hitPos,
      isHeavy ? 0xfacc15 : atk.profile.beamColor,
      isHeavy ? 24 : 14,
      isHeavy ? 28 : 19,
      isHeavy ? 1.25 : 0.92,
    )
    def.effects.spawnImpactRing(
      hitPos,
      isHeavy ? 0xfef08a : atk.profile.burstColor,
      isHeavy ? 7.2 : 4.6,
    )
    def.effects.spawnHitFlash(hitPos, 0xffffff, isHeavy ? 1.38 : 0.95)

    if (isHeavy) {
      def.effects.spawnDebris(hitPos, 10, 18)
      def.effects.flashDynamicLight(hitPos, 0xfacc15, 32, 0.3)
      this.arena.groundImpact(def.hero.currentX, def.hero.worldZ, this.elapsedTime, 5.5)
      this.addHitStop(0.08)
      this.addTrauma(defenderSlot, 0.48)
      this.addTrauma(attackerSlot, 0.34)
    } else {
      this.addHitStop(0.045)
      this.addTrauma(defenderSlot, 0.28)
      this.addTrauma(attackerSlot, 0.18)
    }

    const txt = `-${rawDamage}${isHeavy ? '!' : ''}`
    this.spawnFloating(
      defenderSlot,
      hitPos,
      txt,
      '#ff4d4f',
      isHeavy ? 1.26 : 1.05,
      isHeavy ? 'crit' : 'normal',
    )
    this.spawnFloating(
      attackerSlot,
      hitPos,
      txt,
      color,
      isHeavy ? 1.28 : 1.05,
      isHeavy ? 'crit' : 'normal',
    )

    if (def.hp <= 0) {
      this.onRoundFinished(attackerSlot)
    } else {
      this.syncDangerAlarm()
    }
    this.emitHud()
  }

  private onRoundFinished(winner: PvpSlot | 'draw') {
    this.roundWinner = winner
    this.beamClashActive = false
    for (const s of [0, 1] as const) {
      this.fighters[s].beamTicksRemaining = 0
      this.fighters[s].effects.setBeamClash(false, 0.5)
      this.fighters[s].effects.stopHeroBeam()
    }
    this.audio.setDangerAlarm(false)

    if (winner === 'draw') {
      this.wins[0] = Math.min(WINS_NEEDED, this.wins[0] + 1)
      this.wins[1] = Math.min(WINS_NEEDED, this.wins[1] + 1)
    } else {
      this.wins[winner] += 1
      const loser = (1 - winner) as PvpSlot
      const loserCenter = this.fighters[loser].hero.getTargetCenter()
      this.fighters[loser].effects.spawnBurst(loserCenter, 0xff6b2b, 34, 30, 1.55)
      this.fighters[loser].effects.spawnDebris(loserCenter, 16, 22)
      this.fighters[loser].effects.spawnImpactRing(loserCenter, 0xffd28a, 10.5)
      this.fighters[loser].effects.flashDynamicLight(loserCenter, 0xff6b2b, 48, 0.45)
      this.fighters[loser].hero.triggerAction('defeat', 99)
      this.audio.playExplosion()
      this.addHitStop(0.12)
      this.addTrauma(0, 0.7)
      this.addTrauma(1, 0.7)
    }

    if (this.wins[0] >= WINS_NEEDED || this.wins[1] >= WINS_NEEDED) {
      const champ: PvpSlot =
        this.wins[0] > this.wins[1]
          ? 0
          : this.wins[1] > this.wins[0]
            ? 1
            : winner === 'draw'
              ? 0
              : winner
      this.matchWinner = champ
      this.phase = 'match-over'
      this.audio.setAmbience(this.activeTheme, false)
      this.fighters[champ].hero.triggerAction('victory', 6)
      this.fighters[(1 - champ) as PvpSlot].hero.triggerAction('defeat', 99)
      this.audio.playVictory()
      this.showCenterBanner(champ === 0 ? 'bannerPvpMatchWinP1' : 'bannerPvpMatchWinP2', 4.0)
    } else {
      this.phase = 'round-ko'
      this.phaseTimer = 2.3
      this.showCenterBanner(
        winner === 'draw'
          ? 'bannerPvpDraw'
          : winner === 0
            ? 'bannerPvpRoundWinP1'
            : 'bannerPvpRoundWinP2',
        2.1,
      )
    }
    this.emitHud()
  }

  private syncDangerAlarm() {
    const anyDanger =
      !this.paused &&
      this.phase === 'fighting' &&
      (this.fighters[0].hp <= PVP_MAX_HP * 0.3 || this.fighters[1].hp <= PVP_MAX_HP * 0.3)
    this.audio.setDangerAlarm(anyDanger)
  }

  private showCenterBanner(key: string, duration: number) {
    this.centerBannerKey = key
    this.centerBannerTimer = duration
  }

  private showFighterBanner(slot: PvpSlot, key: string, duration: number) {
    this.fighters[slot].bannerKey = key
    this.fighters[slot].bannerTimer = duration
  }

  private addTrauma(slot: PvpSlot, amount: number) {
    this.fighters[slot].shakeTrauma = Math.min(1.05, this.fighters[slot].shakeTrauma + amount)
  }

  private addHitStop(seconds: number) {
    this.hitStopTimer = Math.max(this.hitStopTimer, seconds)
  }

  private spawnFloating(
    viewerSlot: PvpSlot,
    worldPos: THREE.Vector3,
    text: string,
    color: string,
    scale = 1,
    kind: FloatingDamageEvent['kind'] = 'normal',
  ) {
    const projected = worldPos.clone().project(this.cameras[viewerSlot])
    const idx = this.floatSpread[viewerSlot]!++ % 5
    const ox = [-4.2, 4.0, -2.0, 2.6, 0][idx]!
    const oy = [-2.4, -1.2, -4.2, -3.2, 0][idx]!
    const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * 100 + ox, 12, 88)
    const y = THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * 100 + oy, 16, 82)
    this.callbacks.onFloatingText(viewerSlot, {
      id: this.floatingIdCounter++,
      text,
      color,
      x,
      y,
      scale,
      driftX: ox * 3.5,
      kind,
    })
  }

  private loop = (now: number) => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.loop)

    const deltaMs = now - this.lastTimestamp
    const rawDt = Math.min(0.05, Math.max(0.001, deltaMs / 1000))
    this.lastTimestamp = now
    if (this.paused) return
    this.elapsedTime += rawDt

    // 分屏自适应性能护航：若持续掉帧（>31ms），自动切换直接双视口渲染并收敛 DPR 至 1.0
    if (deltaMs > 1 && deltaMs < 180) {
      this.smoothFrameMs = this.smoothFrameMs * 0.9 + deltaMs * 0.1
      if (this.useBloom && this.smoothFrameMs > 31) {
        this.slowFrameTime += rawDt
        if (this.slowFrameTime > 1.4) {
          this.useBloom = false
          this.renderer.setPixelRatio(1)
          this.renderer.toneMappingExposure = 1.08
        }
      } else {
        this.slowFrameTime = Math.max(0, this.slowFrameTime - rawDt * 0.5)
      }
    }

    let dt = rawDt
    if (this.hitStopTimer > 0) {
      this.hitStopTimer = Math.max(0, this.hitStopTimer - rawDt)
      dt = rawDt * 0.1
    }

    this.stepSimulation(dt, rawDt, now)
    this.renderSplitViews()
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    if (this.centerBannerTimer > 0) {
      this.centerBannerTimer = Math.max(0, this.centerBannerTimer - dt)
      if (this.centerBannerTimer <= 0) this.centerBannerKey = null
    }

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      const opp = this.fighters[(1 - slot) as PvpSlot]
      if (f.discCooldown > 0) f.discCooldown = Math.max(0, f.discCooldown - dt)
      if (f.beamCooldown > 0) f.beamCooldown = Math.max(0, f.beamCooldown - dt)
      if (f.guardBrokenCd > 0) f.guardBrokenCd = Math.max(0, f.guardBrokenCd - rawDt)
      if (f.bannerTimer > 0) {
        f.bannerTimer = Math.max(0, f.bannerTimer - dt)
        if (f.bannerTimer <= 0) f.bannerKey = null
      }
      f.chainTimeLeft = Math.max(0, f.chainTimeLeft - rawDt)
      if (f.chainTimeLeft === 0) f.punchChain = 0
      if (f.combo > 0) {
        f.comboTimer -= dt
        if (f.comboTimer <= 0) f.combo = 0
      }

      const lean =
        f.manualLean !== 0 ? f.manualLean : this.controlMode === 'camera' ? f.gestureLean : 0
      const guarding = this.isFighterGuarding(slot)
      if (guarding && !f.wasGuarding) {
        f.guardStartedAt = this.elapsedTime
      }
      f.wasGuarding = guarding

      if (guarding) {
        f.guardStamina = Math.max(0, f.guardStamina - rawDt * 22)
        if (f.guardStamina <= 0) {
          f.guardBrokenCd = 1.4
          f.manualGuard = false
        }
      } else {
        f.guardStamina = Math.min(100, f.guardStamina + rawDt * 30)
      }

      f.hero.setLean(lean)
      f.hero.setGuard(guarding)
      f.hero.setBeamCharge(
        this.controlMode === 'camera' ? f.gestureBeamCharge : 0,
        f.gestureBeamArmSide,
      )
      f.hero.setDiscCharge(
        this.controlMode === 'camera' ? f.gestureDiscCharge : 0,
        f.gestureDiscSide,
      )
      // 双雄战斗时头眼死锁对手面部（复用临时向量零 GC）
      if (this.phase === 'fighting') {
        this.tmpLookOffset.copy(opp.hero.getTargetCenter())
        this.tmpLookOffset.y += 2.2
        f.hero.setLookTarget(this.tmpLookOffset)
      } else {
        f.hero.setLookTarget(null)
      }

      const danger = this.phase === 'fighting' && f.hp > 0 && f.hp <= PVP_MAX_HP * 0.3
      f.hero.update(dt, this.elapsedTime, danger, nowMs, rawDt)

      // 拳脚动态拖尾丝带
      const info = f.hero.getStrikeContactInfo()
      f.effects.updateLimbTrail(
        'handL',
        info.limb === 'handL' && info.progress >= 0.12 && info.progress <= 0.56,
        f.hero.getFistOrigin('left'),
        f.profile.accentColor,
        rawDt,
      )
      f.effects.updateLimbTrail(
        'handR',
        info.limb === 'handR' && info.progress >= 0.12 && info.progress <= 0.56,
        f.hero.getFistOrigin('right'),
        f.profile.accentColor,
        rawDt,
      )
      f.effects.updateLimbTrail(
        'footL',
        info.limb === 'footL' && info.progress >= 0.12 && info.progress <= 0.62,
        f.hero.getFootOrigin('left'),
        0xf97316,
        rawDt,
      )
      f.effects.updateLimbTrail(
        'footR',
        info.limb === 'footR' && info.progress >= 0.12 && info.progress <= 0.62,
        f.hero.getFootOrigin('right'),
        0xf97316,
        rawDt,
      )
    }

    this.arena.update(
      this.elapsedTime,
      this.fighters[0].hero.root.position,
      this.fighters[1].hero.root.position,
      true,
      this.cameras[0].position,
      rawDt,
    )

    if (this.phase === 'round-intro') {
      this.phaseTimer -= dt
      if (this.phaseTimer <= 0) {
        this.phase = 'fighting'
        this.showCenterBanner('bannerPvpFight', 0.85)
        this.emitHud()
      }
    } else if (this.phase === 'round-ko') {
      this.phaseTimer -= dt
      if (this.phaseTimer <= 0) {
        this.beginRound(this.round + 1)
      }
    } else if (this.phase === 'fighting') {
      this.stepPvpCombat(dt)
    }

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      const opp = this.fighters[(1 - slot) as PvpSlot]
      const beamSeg = f.hero.getBeamOriginSegment()
      const oppSeg = opp.hero.getBeamOriginSegment()
      const oppEmit = this.tmpOppEmit.copy(oppSeg[0]).lerp(oppSeg[1], 0.58)
      const oppCenter = opp.hero.getTargetCenter()

      f.effects.update(
        dt,
        this.elapsedTime,
        beamSeg,
        oppCenter,
        this.beamClashActive ? oppEmit : this.tmpZeroVec,
        f.hero.getTargetCenter(),
        this.cameras[slot].quaternion,
        this.cameras[slot].position,
      )
      f.effects.updateShield(
        this.isFighterGuarding(slot),
        f.hero.currentX,
        f.hero.worldZ,
        dt,
        this.elapsedTime,
        f.sideSign,
      )
      f.effects.updateChargePreview(
        this.controlMode === 'camera' ? f.gestureBeamCharge : 0,
        this.tmpBeamMid.copy(beamSeg[0]).lerp(beamSeg[1], 0.55),
        this.controlMode === 'camera' ? f.gestureDiscCharge : 0,
        f.hero.getDiscOrigin(f.gestureDiscSide ?? 'right'),
        this.elapsedTime,
      )
      f.effects.updateTypeCharge(
        this.controlMode === 'camera' && f.profile.forms ? f.gestureTypeCharge : 0,
        this.tmpTypePos.set(f.hero.currentX, 15.2, f.hero.worldZ),
        this.getActiveForm(slot)?.accentColor ?? 0xb388ff,
        this.elapsedTime,
      )
    }

    this.updateCameras(rawDt)

    this.hudAccumulator += dt
    if (this.hudAccumulator >= 0.06) {
      this.hudAccumulator = 0
      this.emitHud()
    }
  }

  private stepPvpCombat(dt: number) {
    this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt)
    if (this.roundTimeLeft <= 0) {
      if (this.fighters[0].hp > this.fighters[1].hp) this.onRoundFinished(0)
      else if (this.fighters[1].hp > this.fighters[0].hp) this.onRoundFinished(1)
      else this.onRoundFinished('draw')
      return
    }

    if (this.beamClashActive) {
      this.beamClashTimer -= dt
      if (this.controlMode === 'camera') {
        const p1Hold = this.fighters[0].gestureBeamHolding ? 0.28 : 0
        const p2Hold = this.fighters[1].gestureBeamHolding ? 0.28 : 0
        this.beamClashBalance = THREE.MathUtils.clamp(
          this.beamClashBalance + (p1Hold - p2Hold) * dt,
          0,
          1,
        )
        this.syncBeamClashVisuals()
      }
      this.addTrauma(0, 0.05)
      this.addTrauma(1, 0.05)

      if (
        this.beamClashBalance >= 0.95 ||
        this.beamClashBalance <= 0.05 ||
        this.beamClashTimer <= 0
      ) {
        this.resolvePvpBeamClash()
      }
      return
    }

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      const oppSlot = (1 - slot) as PvpSlot
      if (f.beamTicksRemaining > 0) {
        f.beamTickTimer -= dt
        if (f.beamTickTimer <= 0) {
          f.beamTickTimer = 0.24
          f.beamTicksRemaining -= 1
          this.inflictDamage(slot, oppSlot, f.beamDamagePerTick, '#38e8ff', false, false)
          if (this.phase !== 'fighting') return
        }
      }
    }

    // 抛射物半途对轰消弹（Clash）
    const p1Projs = this.fighters[0].effects.projectiles
    const p2Projs = this.fighters[1].effects.projectiles
    for (const a of p1Projs) {
      if (a.hitTriggered) continue
      for (const b of p2Projs) {
        if (b.hitTriggered) continue
        if (a.pos.distanceTo(b.pos) < 3.4) {
          a.hitTriggered = true
          b.hitTriggered = true
          const mid = a.pos.clone().lerp(b.pos, 0.5)
          this.fighters[0].effects.spawnBurst(mid, 0xfef08a, 22, 26, 1.2)
          this.fighters[0].effects.spawnImpactRing(mid, 0xfacc15, 6.4)
          this.fighters[0].effects.spawnHitFlash(mid, 0xffffff, 1.35)
          this.fighters[0].effects.flashDynamicLight(mid, 0xfef08a, 26, 0.22)
          this.audio.playDeflect()
          this.gainEnergy(0, 12)
          this.gainEnergy(1, 12)
          this.addHitStop(0.05)
          this.addTrauma(0, 0.22)
          this.addTrauma(1, 0.22)
          this.spawnFloating(0, mid, 'CLASH!', '#fde047', 1.15, 'guard')
          this.spawnFloating(1, mid, 'CLASH!', '#fde047', 1.15, 'guard')
          break
        }
      }
    }

    for (const slot of [0, 1] as const) {
      const atk = this.fighters[slot]
      const defSlot = (1 - slot) as PvpSlot
      const def = this.fighters[defSlot]

      for (const proj of atk.effects.projectiles) {
        if (this.phase !== 'fighting') return
        if (proj.hitTriggered) continue

        const crossedLine =
          slot === 0 ? proj.pos.z <= def.hero.worldZ + 2.4 : proj.pos.z >= def.hero.worldZ - 2.4
        if (!crossedLine) continue

        proj.hitTriggered = true
        const hitRadius =
          proj.kind === 'ultra-disc' ? 3.4 : proj.kind === 'kick-wave' ? 3.2 : 2.95
        const lateralDist = Math.abs(proj.pos.x - def.hero.currentX)

        if (lateralDist > hitRadius) {
          def.perfectDodges++
          this.gainEnergy(defSlot, 18)
          this.audio.playBulletTime()
          this.triggerSlotFlash(defSlot, 'dodge')
          const dodgePos = def.hero.getTargetCenter().add(new THREE.Vector3(0, 4.2, 0))
          this.spawnFloating(defSlot, dodgePos, 'PERFECT DODGE!', '#4ade80', 1.2, 'dodge')
          this.spawnFloating(slot, dodgePos, 'MISS!', '#94a3b8', 0.95)
          continue
        }

        this.gainEnergy(slot, proj.kind === 'ultra-disc' ? 16 : proj.finisher ? 15 : 10)
        if (proj.kind === 'palm-bolt' || proj.kind === 'punch-wave') {
          this.audio.playImpact('metal', !!proj.finisher, atk.combo + 1)
          if (proj.finisher) this.showFighterBanner(slot, 'bannerTriple', 0.9)
          this.inflictDamage(
            slot,
            defSlot,
            proj.damage,
            proj.finisher ? '#fef08a' : '#fde047',
            !!proj.finisher,
          )
        } else if (proj.kind === 'kick-wave') {
          this.audio.playImpact('metal', true, atk.combo + 1)
          this.inflictDamage(slot, defSlot, proj.damage, '#fb923c', true)
        } else if (proj.kind === 'ultra-disc') {
          this.audio.playImpact('metal', true, atk.combo + 1)
          this.inflictDamage(slot, defSlot, proj.damage, '#67e8f9', true)
        }
      }
    }
  }

  private updateCameras(dt: number) {
    const aspect = this.getSlotAspect()
    const wideFactor = THREE.MathUtils.clamp((aspect - 0.68) / 0.72, 0, 1)

    if (this.phase === 'menu') {
      const cam = this.cameras[0]
      const sway = Math.sin(this.elapsedTime * 0.55) * 0.65
      const menuWide = THREE.MathUtils.clamp((aspect - 1.1) / 0.68, 0, 1)
      const menuDistX = THREE.MathUtils.lerp(28.5, 22.8, menuWide)
      const targetPos = this.tmpCamTarget.set(menuDistX, 9.8, sway * 1.1)
      const targetLook = this.tmpLookTarget.set(0, 7.5, 0)
      this.fighters[0].camAnchor.lerp(targetPos, 1 - Math.exp(-dt * 5))
      this.fighters[0].lookAnchor.lerp(targetLook, 1 - Math.exp(-dt * 6))
      cam.aspect = aspect
      cam.fov = 45
      cam.position.copy(this.fighters[0].camAnchor)
      cam.lookAt(this.fighters[0].lookAnchor)
      cam.updateProjectionMatrix()
      return
    }

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      const opp = this.fighters[(1 - slot) as PvpSlot]
      const cam = this.cameras[slot]
      const s = f.sideSign

      const targetCam = this.tmpCamTarget.set(0, 0, 0)
      const targetLook = this.tmpLookTarget.set(0, 0, 0)

      if (this.phase === 'match-over' && this.matchWinner === slot) {
        targetCam.set(s * 3.2, 9.2, s * 22.5)
        targetLook.copy(f.hero.root.position).add(new THREE.Vector3(0, 7, 0))
      } else if (this.beamClashActive) {
        // 控制在 ±14.0 主干道安全走廊内并拉开纵深，避免路灯遮挡同时全景呈现双色光线对撞
        const clashSideX = s * THREE.MathUtils.lerp(13.0, 14.0, wideFactor)
        targetCam.set(clashSideX, 10.6, s * 11.4)
        targetLook.set(0, 8.6, 0)
      } else if (f.effects.isHeroBeamActive()) {
        const armSign = f.gestureBeamArmSide === 'left' ? -1 : 1
        const beamOffsetX = s * armSign * THREE.MathUtils.lerp(3.0, 6.8, wideFactor)
        targetCam.set(f.hero.currentX * 0.45 + beamOffsetX, 10.8, s * 17.8)
        targetLook.set(opp.hero.currentX * 0.5, 9.0, opp.hero.worldZ * 0.45)
      } else {
        const shoulderX = s * THREE.MathUtils.lerp(2.7, 4.1, wideFactor)
        const camDistZ = THREE.MathUtils.lerp(22.8, 20.6, wideFactor)
        targetCam.set(f.hero.currentX * 0.6 + shoulderX, 11.7, s * camDistZ)
        targetLook.set(
          f.hero.currentX * 0.18 + opp.hero.currentX * 0.72 - shoulderX * 0.14,
          8.5,
          opp.hero.worldZ * 0.78,
        )
      }

      f.camAnchor.lerp(targetCam, 1 - Math.exp(-dt * 7.5))
      f.lookAnchor.lerp(targetLook, 1 - Math.exp(-dt * 9.0))
      cam.position.copy(f.camAnchor)

      f.fovKick += (0 - f.fovKick) * (1 - Math.exp(-dt * 10))
      const narrowComp = Math.max(0, (1.18 - aspect) * 15)
      cam.aspect = aspect
      cam.fov = THREE.MathUtils.clamp(46 + narrowComp + f.fovKick, 38, 66)
      cam.updateProjectionMatrix()

      f.shakeTrauma = Math.max(0, f.shakeTrauma - dt * 1.8)
      const shake = f.shakeTrauma * f.shakeTrauma * 1.3
      if (shake > 0.001) {
        const t = this.elapsedTime + slot * 7.1
        cam.position.x += (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 31.7) * 0.4) * shake
        cam.position.y += (Math.sin(t * 39.1) * 0.6 + Math.sin(t * 27.3) * 0.4) * shake
      }
      cam.lookAt(f.lookAnchor)
      if (shake > 0.001) {
        cam.rotation.z += Math.sin(this.elapsedTime * 35.7) * 0.03 * shake
      }
    }
  }

  /** 双视口渲染（每帧单次 ShadowMap 更新 + 支持高画质双路半分辨率 Bloom 与低负载直出无缝切换） */
  private renderSplitViews() {
    const w = this.fullWidth
    const h = this.fullHeight
    // 每帧显式只更新一次阴影贴图，双半屏相机共享同一张 ShadowMap
    this.renderer.shadowMap.needsUpdate = true

    if (this.phase === 'menu') {
      this.renderer.setScissorTest(false)
      this.renderer.setViewport(0, 0, w, h)
      if (this.useBloom) this.menuComposer.render()
      else this.renderer.render(this.scene, this.cameras[0])
      return
    }

    if (!this.useBloom) {
      this.renderer.setRenderTarget(null)
      this.renderer.setScissorTest(true)
      const prevAutoClear = this.renderer.autoClear
      this.renderer.autoClear = false
      this.renderer.clear()
      if (this.portraitSplit) {
        const halfH = Math.floor(h * 0.5)
        const topH = h - halfH
        this.renderer.setViewport(0, halfH, w, topH)
        this.renderer.setScissor(0, halfH, w, topH)
        this.renderer.render(this.scene, this.cameras[0])

        this.renderer.setViewport(0, 0, w, halfH)
        this.renderer.setScissor(0, 0, w, halfH)
        this.renderer.render(this.scene, this.cameras[1])
      } else {
        const halfW = Math.floor(w * 0.5)
        const rightW = w - halfW
        this.renderer.setViewport(0, 0, halfW, h)
        this.renderer.setScissor(0, 0, halfW, h)
        this.renderer.render(this.scene, this.cameras[0])

        this.renderer.setViewport(halfW, 0, rightW, h)
        this.renderer.setScissor(halfW, 0, rightW, h)
        this.renderer.render(this.scene, this.cameras[1])
      }
      this.renderer.setScissorTest(false)
      this.renderer.autoClear = prevAutoClear
      return
    }

    // 1. 分别离屏渲染两路带选择性 Bloom + ACES 色调映射的高精缓冲（仅第 1 路更新 ShadowMap）
    this.renderer.setScissorTest(false)
    this.splitComposers[0].render()
    this.splitComposers[1].render()

    // 2. 切回主画布并按横/竖分屏区域贴图合成
    this.renderer.setRenderTarget(null)
    this.renderer.setScissorTest(true)
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.clear()

    if (this.portraitSplit) {
      const halfH = Math.floor(h * 0.5)
      const topH = h - halfH
      this.blitMat.uniforms.uMap!.value = this.splitComposers[0].readBuffer.texture
      this.renderer.setViewport(0, halfH, w, topH)
      this.renderer.setScissor(0, halfH, w, topH)
      this.renderer.render(this.blitScene, this.blitCamera)

      this.blitMat.uniforms.uMap!.value = this.splitComposers[1].readBuffer.texture
      this.renderer.setViewport(0, 0, w, halfH)
      this.renderer.setScissor(0, 0, w, halfH)
      this.renderer.render(this.blitScene, this.blitCamera)
    } else {
      const halfW = Math.floor(w * 0.5)
      const rightW = w - halfW
      this.blitMat.uniforms.uMap!.value = this.splitComposers[0].readBuffer.texture
      this.renderer.setViewport(0, 0, halfW, h)
      this.renderer.setScissor(0, 0, halfW, h)
      this.renderer.render(this.blitScene, this.blitCamera)

      this.blitMat.uniforms.uMap!.value = this.splitComposers[1].readBuffer.texture
      this.renderer.setViewport(halfW, 0, rightW, h)
      this.renderer.setScissor(halfW, 0, rightW, h)
      this.renderer.render(this.blitScene, this.blitCamera)
    }
    this.renderer.setScissorTest(false)
    this.renderer.autoClear = prevAutoClear
  }

  private buildFighterHud(slot: PvpSlot): PvpFighterHud {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    let chargeKind: PvpFighterHud['chargeKind'] = null
    let chargeProgress = 0
    if (this.isFighterGuarding(slot)) {
      chargeKind = 'guard'
      chargeProgress = f.guardStamina / 100
    } else if (f.gestureBeamCharge > 0.05) {
      chargeKind = 'beam'
      chargeProgress = f.gestureBeamCharge
    } else if (f.gestureDiscCharge > 0.05) {
      chargeKind = 'disc'
      chargeProgress = f.gestureDiscCharge
    } else if (f.gestureTypeCharge > 0.05) {
      chargeKind = 'type'
      chargeProgress = f.gestureTypeCharge
    }
    const discMax = DISC_BASE_CD * (this.getActiveForm(slot)?.discCooldownMul ?? 1)

    return {
      heroId: f.profile.id,
      heroForm: this.getActiveForm(slot)?.id ?? 'base',
      hasForms: !!f.profile.forms,
      hp: Math.round(f.hp),
      maxHp: PVP_MAX_HP,
      guardStamina: Math.round(f.guardStamina),
      energy: Math.round(f.energy),
      combo: f.combo,
      maxCombo: f.maxCombo,
      perfectGuards: f.perfectGuards,
      perfectDodges: f.perfectDodges,
      punchChain: f.punchChain,
      discCooldownRatio: THREE.MathUtils.clamp(f.discCooldown / discMax, 0, 1),
      beamCooldownRatio: THREE.MathUtils.clamp(f.beamCooldown / BEAM_BASE_CD, 0, 1),
      chargeKind,
      chargeProgress,
      incomingBeamAlert:
        this.phase === 'fighting' &&
        !this.beamClashActive &&
        opp.effects.isHeroBeamActive() &&
        !f.effects.isHeroBeamActive(),
      activeBannerKey: f.bannerKey,
      impactFlashKind: f.impactFlashKind,
      impactFlashSeq: f.impactFlashSeq,
      tracking: f.gestureTracking,
      bodyCoverage: f.gestureCoverage,
      distanceHint: f.gestureDistanceHint,
      activeGestureCue: f.gestureActiveCue,
      mirroredCenterX: f.gestureMirroredX,
      poseHintKey: f.gestureHintKey,
      timerDanger: this.phase === 'fighting' && f.hp > 0 && f.hp <= PVP_MAX_HP * 0.3,
    }
  }

  public getHudSnapshot(): PvpHudState {
    return {
      phase: this.phase,
      controlMode: this.controlMode,
      loadingProgress: this.loadingProgress,
      activeTheme: this.arena.getTheme(),
      portraitSplit: this.portraitSplit,
      round: this.round,
      maxRounds: 3,
      roundTimeLeft: Math.ceil(this.roundTimeLeft),
      wins: [this.wins[0], this.wins[1]],
      roundWinner: this.roundWinner,
      matchWinner: this.matchWinner,
      centerBannerKey: this.centerBannerKey,
      beamClashActive: this.beamClashActive,
      beamClashBalance: this.beamClashBalance,
      fighters: [this.buildFighterHud(0), this.buildFighterHud(1)],
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
    for (const f of this.fighters) {
      f.effects.dispose()
      f.hero.dispose()
    }
    this.arena.dispose()
    this.menuComposer.dispose()
    this.splitComposers[0].dispose()
    this.splitComposers[1].dispose()
    this.blitQuad.geometry.dispose()
    this.blitMat.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
