import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { UltraAudio } from './audio'
import { BattleEffects } from './effects'
import { ArenaManager } from './environment'
import { UltraGestureRecognizer } from './gesture'
import { HERO_PROFILES } from './heroes'
import type { HeroFormSpec, HeroId, HeroProfile } from './heroes'
import { HeroController } from './hero'
import { canTrackFeet, JumpKickRecognizer } from './jump'
import type {
  ConcreteSceneTheme,
  ControlMode,
  FloatingDamageEvent,
  PoseLandmark,
} from './types'

export type PvpPhase = 'menu' | 'loading' | 'round-intro' | 'fighting' | 'round-ko' | 'match-over'
export type PvpSlot = 0 | 1

export interface PvpFighterHud {
  heroId: HeroId
  heroForm: string
  hasForms: boolean
  hp: number
  maxHp: number
  energy: number
  combo: number
  maxCombo: number
  perfectGuards: number
  punchChain: number
  discCooldownRatio: number
  beamCooldownRatio: number
  chargeKind: 'beam' | 'disc' | 'guard' | 'type' | null
  chargeProgress: number
  incomingBeamAlert: boolean
  activeBannerKey: string | null
  tracking: boolean
  bodyCoverage: 'none' | 'upper' | 'full'
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
  /** 对波天平 [0, 1]：0.5 势均力敌，越接近 1 代表 P1 压倒 P2，越接近 0 代表 P2 压倒 P1 */
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
  energy: number
  combo: number
  maxCombo: number
  comboTimer: number
  perfectGuards: number
  punchChain: number
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
  gestureHintKey: string
  gestureBeamCharge: number
  gestureBeamHolding: boolean
  gestureBeamArmSide: 'left' | 'right'
  gestureDiscCharge: number
  gestureDiscSide: 'left' | 'right' | null
  gestureTypeCharge: number
  bannerKey: string | null
  bannerTimer: number
  shakeTrauma: number
  fovKick: number
  camAnchor: THREE.Vector3
  lookAnchor: THREE.Vector3
}

const PVP_MAX_HP = 140
const PVP_ROUND_SECONDS = 90
const DISC_BASE_CD = 1.45
const BEAM_BASE_CD = 2.0
const WINS_NEEDED = 2

/**
 * 第三人称 3D 同场双人分屏对战主引擎（P1 奥特曼 VS P2 奥特曼）：
 * - 单一共享 3D 世界 + 单 WebGLRenderer 双视口（setViewport/setScissor）对称越肩渲染
 * - 整备菜单全屏展示双雄面对面对峙，开战切入各自第三人称越肩视角
 * - 支持真实三维横向侧闪躲避、拳风/光轮空中对轰消弹、飞踢碎盾、以及真人双奥特曼宿命光线对波！
 */
export class UltramanSplitPvpEngine {
  private readonly container: HTMLElement
  private readonly callbacks: PvpEngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly cameras: [THREE.PerspectiveCamera, THREE.PerspectiveCamera]
  private readonly loader = new GLTFLoader()

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
  private activeTheme: ConcreteSceneTheme = 'seaside'
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
  private portraitSplit = false
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(this.fullWidth, this.fullHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.06

    container.appendChild(this.renderer.domElement)

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
      energy: 45,
      combo: 0,
      maxCombo: 0,
      comboTimer: 0,
      perfectGuards: 0,
      punchChain: 0,
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
      gestureHintKey: 'hintStandCenter',
      gestureBeamCharge: 0,
      gestureBeamHolding: false,
      gestureBeamArmSide: 'right',
      gestureDiscCharge: 0,
      gestureDiscSide: null,
      gestureTypeCharge: 0,
      bannerKey: null,
      bannerTimer: 0,
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
    this.audio.playTransform()
    this.emitHud()
  }

  public setControlMode(mode: ControlMode) {
    this.controlMode = mode
    this.emitHud()
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
    if (muted) this.audio.setDangerAlarm(false)
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
    }
    this.audio.playTransform()
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
      f.energy = 45
      f.combo = 0
      f.comboTimer = 0
      f.punchChain = 0
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
    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      f.effects.clearAllDynamic()
      f.hero.resetPose()
      f.hero.triggerAction('pose-intro', 0.85)
    }
    this.emitHud()
  }

  /** 喂入单侧玩家的姿态骨骼数据（镜像左半区 P1 laneCenter=0.75，右半区 P2 laneCenter=0.25） */
  public feedPlayerPose(
    slot: PvpSlot,
    landmarks: PoseLandmark[] | null,
    worldLandmarks: PoseLandmark[] | null,
    now: number,
    width: number,
    height: number,
    laneCenter: number,
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
    )
    f.gestureTracking = snap.tracking
    const fullBody = snap.coverage === 'full' && canTrackFeet(landmarks)
    const physicalKick = fullBody && f.feetTracked ? snap.kick : null
    f.feetTracked = fullBody
    f.gestureCoverage = fullBody ? 'full' : snap.tracking ? 'upper' : 'none'
    f.gestureLean = snap.lean
    f.gestureGuard = snap.guard
    if (snap.guardJustStarted) {
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
      this.executeKick(slot, 'right', true)
    } else if (snap.typeTrigger) {
      this.switchFormInBattle(slot)
    } else if (snap.beamTrigger) {
      this.executeBeam(slot)
    } else if (snap.discTrigger) {
      this.executeDisc(slot, snap.discTrigger)
    } else if (physicalKick) {
      this.executeKick(slot, physicalKick, false)
    } else if (snap.punch) {
      this.executePunch(slot, snap.punch)
    }
  }

  // ---- 双人键盘 / 手动指令入口 ----

  public setManualLean(slot: PvpSlot, dir: -1 | 0 | 1) {
    this.fighters[slot].manualLean = dir
  }

  public setManualGuard(slot: PvpSlot, active: boolean) {
    const f = this.fighters[slot]
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
    this.executePunch(slot, side)
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
    this.audio.playTransform()
    this.addTrauma(slot, 0.3)
    f.fovKick = -3.0
    this.showFighterBanner(slot, `bannerForm${form.bannerKey}`, 1.25)
    this.emitHud()
  }

  private executePunch(slot: PvpSlot, side: 'left' | 'right') {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    if (f.effects.isHeroBeamActive()) return

    f.punchChain = f.chainTimeLeft > 0 && f.lastPunchSide !== side ? f.punchChain + 1 : 1
    const finisher = f.punchChain >= 3
    f.lastPunchSide = side
    f.chainTimeLeft = finisher ? 0 : 1.5

    f.hero.triggerAction(
      finisher ? 'punch-heavy' : side === 'left' ? 'punch-left' : 'punch-right',
      finisher ? 0.38 : 0.28,
    )
    if (finisher) f.fovKick = -2.4

    const origin = f.hero.getFistOrigin(side)
    const target = opp.hero.getTargetCenter()
    const damage = Math.round((finisher ? 26 : 13) * this.getDamageMul(slot))
    f.effects.spawnPunchWave(origin, target, damage, side, finisher)
    f.effects.spawnBurst(origin, f.profile.burstColor, 6, 14, 0.6)
    this.audio.playSwing(side, false)
    if (finisher) f.punchChain = 0
    this.emitHud()
  }

  private executeKick(slot: PvpSlot, side: 'left' | 'right', jumping: boolean) {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    if (f.effects.isHeroBeamActive()) return

    f.hero.triggerAction(
      jumping ? 'jump-kick' : side === 'left' ? 'kick-left' : 'kick-right',
      jumping ? 0.46 : 0.36,
    )
    f.fovKick = jumping ? -3.2 : -2.2
    const origin = f.hero.getFootOrigin(side)
    const target = opp.hero.getTargetCenter()
    const damage = Math.round((jumping ? 28 : 21) * this.getDamageMul(slot))
    f.effects.spawnKickWave(origin, target, damage)
    f.effects.spawnBurst(origin, 0xf97316, 10, 16, 0.8)
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

    // 若对面此时正在发射必杀光线 -> 瞬间引爆双奥特曼宿命光线对波！！
    if (opp.effects.isHeroBeamActive()) {
      this.startPvpBeamClash(slot, isSuper)
      return
    }

    const dur = isSuper ? 1.65 : 1.25
    f.hero.triggerAction('beam', dur)
    f.effects.startHeroBeam(isSuper, dur)
    this.audio.playBeam(isSuper)
    this.addTrauma(slot, isSuper ? 0.55 : 0.38)
    this.addTrauma(oppSlot, 0.25)
    f.fovKick = isSuper ? -4.0 : -2.8

    // 首段命中延迟 0.38s，给对面玩家留出交叉防御或按下光线键反制对波的精彩博弈窗口！
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
    // 满能量超光线享有初始对波身位优势
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
    // effects[0] 的 clashProgress 表示从 P1 射向 P2 的比例；effects[1] 为互补比例 1 - balance
    this.fighters[0].effects.setBeamClash(this.beamClashActive, this.beamClashBalance)
    // 只由 effects[0] 渲染中央奇点光球，effects[1] 仅截断光束终点对齐奇点即可
    this.fighters[1].effects.setBeamClash(this.beamClashActive, 1 - this.beamClashBalance)
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
    loser.effects.spawnImpactRing(hitPos, 0xfacc15, 10.5)
    loser.effects.spawnHitFlash(hitPos, 0xffffff, 2.0)
    this.arena.groundImpact(loser.hero.currentX, loser.hero.worldZ, this.elapsedTime)
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

    // 防御判定（对波压制爆破不可防御）
    if (!unblockable && this.isFighterGuarding(defenderSlot)) {
      const isJustGuard = this.elapsedTime - def.guardStartedAt <= 0.68
      if (isJustGuard) {
        def.perfectGuards += 1
        this.gainEnergy(defenderSlot, 26)
        this.audio.playGuardBlock()
        def.effects.triggerShieldBlockFlash()
        def.effects.spawnBurst(hitPos, 0xfef08a, 20, 22, 1.05)
        def.effects.spawnImpactRing(hitPos, 0xfef08a, 6.2)
        this.addHitStop(0.055)
        this.addTrauma(defenderSlot, 0.28)
        this.addTrauma(attackerSlot, 0.28)
        this.spawnFloating(defenderSlot, hitPos, 'PERFECT GUARD!', '#38bdf8', 1.22, 'guard')
        this.spawnFloating(attackerSlot, hitPos, 'PARRIED!', '#38bdf8', 1.12, 'guard')
        this.showFighterBanner(defenderSlot, 'bannerPerfectGuard', 0.9)
        this.emitHud()
        return
      }

      // 长时间死架护盾时，飞踢重击可直接踢碎护盾！
      if (isHeavy && atk.hero.getAction().includes('kick')) {
        def.manualGuard = false
        def.gestureGuard = false
        this.audio.playHeavyImpact()
        this.spawnFloating(defenderSlot, hitPos, 'GUARD BREAK!', '#fb923c', 1.24, 'crit')
      } else {
        const chip = Math.max(2, Math.round(rawDamage * 0.22))
        def.hp = Math.max(1, def.hp - chip)
        this.gainEnergy(defenderSlot, 9)
        this.audio.playGuardBlock()
        def.effects.triggerShieldBlockFlash()
        def.effects.spawnBurst(hitPos, 0x7dd3fc, 10, 18, 0.9)
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

    def.hero.triggerAction('hit', 0.38)
    def.effects.spawnBurst(
      hitPos,
      isHeavy ? 0xfacc15 : atk.profile.beamColor,
      isHeavy ? 22 : 14,
      isHeavy ? 26 : 19,
      isHeavy ? 1.2 : 0.9,
    )
    def.effects.spawnImpactRing(hitPos, isHeavy ? 0xfef08a : atk.profile.burstColor, isHeavy ? 6.8 : 4.5)
    def.effects.spawnHitFlash(hitPos, 0xffffff, isHeavy ? 1.35 : 0.95)

    if (isHeavy) {
      this.arena.groundImpact(def.hero.currentX, def.hero.worldZ, this.elapsedTime)
      this.addHitStop(0.075)
      this.addTrauma(defenderSlot, 0.48)
      this.addTrauma(attackerSlot, 0.34)
    } else {
      this.addHitStop(0.042)
      this.addTrauma(defenderSlot, 0.28)
      this.addTrauma(attackerSlot, 0.18)
    }

    const txt = `-${rawDamage}${isHeavy ? '!' : ''}`
    this.spawnFloating(defenderSlot, hitPos, txt, '#ff4d4f', isHeavy ? 1.26 : 1.05, isHeavy ? 'crit' : 'normal')
    this.spawnFloating(attackerSlot, hitPos, txt, color, isHeavy ? 1.28 : 1.05, isHeavy ? 'crit' : 'normal')

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
      this.fighters[loser].effects.spawnBurst(loserCenter, 0xff6b2b, 32, 30, 1.5)
      this.fighters[loser].effects.spawnImpactRing(loserCenter, 0xffd28a, 10)
      this.fighters[loser].hero.triggerAction('defeat', 99)
      this.audio.playExplosion()
      this.addHitStop(0.12)
      this.addTrauma(0, 0.7)
      this.addTrauma(1, 0.7)
    }

    // 检查是否决出整场三局两胜总冠军
    if (this.wins[0] >= WINS_NEEDED || this.wins[1] >= WINS_NEEDED) {
      const champ: PvpSlot =
        this.wins[0] > this.wins[1] ? 0 : this.wins[1] > this.wins[0] ? 1 : winner === 'draw' ? 0 : winner
      this.matchWinner = champ
      this.phase = 'match-over'
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
    this.renderSplitViews()
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    if (this.centerBannerTimer > 0) {
      this.centerBannerTimer = Math.max(0, this.centerBannerTimer - dt)
      if (this.centerBannerTimer <= 0) this.centerBannerKey = null
    }

    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      if (f.discCooldown > 0) f.discCooldown = Math.max(0, f.discCooldown - dt)
      if (f.beamCooldown > 0) f.beamCooldown = Math.max(0, f.beamCooldown - dt)
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

      const danger = this.phase === 'fighting' && f.hp > 0 && f.hp <= PVP_MAX_HP * 0.3
      f.hero.update(dt, this.elapsedTime, danger, nowMs, rawDt)
    }

    this.arena.update(
      this.elapsedTime,
      this.fighters[0].hero.root.position,
      this.fighters[1].hero.root.position,
      true,
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

    // 更新双方独立特效池
    const zeroVec = new THREE.Vector3()
    for (const slot of [0, 1] as const) {
      const f = this.fighters[slot]
      const opp = this.fighters[(1 - slot) as PvpSlot]
      const beamSeg = f.hero.getBeamOriginSegment()
      const oppSeg = opp.hero.getBeamOriginSegment()
      const oppEmit = oppSeg[0].clone().lerp(oppSeg[1], 0.58)
      const oppCenter = opp.hero.getTargetCenter()

      f.effects.update(
        dt,
        this.elapsedTime,
        beamSeg,
        oppCenter,
        this.beamClashActive ? oppEmit : zeroVec,
        f.hero.getTargetCenter(),
        this.cameras[slot].quaternion,
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
        beamSeg[0].clone().lerp(beamSeg[1], 0.55),
        this.controlMode === 'camera' ? f.gestureDiscCharge : 0,
        f.hero.getDiscOrigin(f.gestureDiscSide ?? 'right'),
        this.elapsedTime,
      )
      f.effects.updateTypeCharge(
        this.controlMode === 'camera' && f.profile.forms ? f.gestureTypeCharge : 0,
        new THREE.Vector3(f.hero.currentX, 15.2, f.hero.worldZ),
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
    // 回合倒计时
    this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt)
    if (this.roundTimeLeft <= 0) {
      if (this.fighters[0].hp > this.fighters[1].hp) this.onRoundFinished(0)
      else if (this.fighters[1].hp > this.fighters[0].hp) this.onRoundFinished(1)
      else this.onRoundFinished('draw')
      return
    }

    // 1. 双人宿命光线对波结算
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

    // 2. 单方必杀光线多段伤害结算
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

    // 3. 双方抛射物半途对轰消弹（Clash）
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
          this.fighters[0].effects.spawnBurst(mid, 0xfef08a, 20, 24, 1.15)
          this.fighters[0].effects.spawnImpactRing(mid, 0xfacc15, 6.2)
          this.fighters[0].effects.spawnHitFlash(mid, 0xffffff, 1.3)
          this.audio.playDeflect()
          this.gainEnergy(0, 12)
          this.gainEnergy(1, 12)
          this.addHitStop(0.045)
          this.addTrauma(0, 0.22)
          this.addTrauma(1, 0.22)
          this.spawnFloating(0, mid, 'CLASH!', '#fde047', 1.15, 'guard')
          this.spawnFloating(1, mid, 'CLASH!', '#fde047', 1.15, 'guard')
          break
        }
      }
    }

    // 4. 抛射物抵达对手战线：真实 3D 侧闪擦肩判定 vs 命中判定
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

        // 对手成功横向侧闪躲开攻击！
        if (lateralDist > hitRadius) {
          this.gainEnergy(defSlot, 15)
          this.audio.playDodge()
          const dodgePos = def.hero.getTargetCenter().add(new THREE.Vector3(0, 4.2, 0))
          this.spawnFloating(defSlot, dodgePos, 'PERFECT DODGE!', '#4ade80', 1.16, 'dodge')
          this.spawnFloating(slot, dodgePos, 'MISS!', '#94a3b8', 0.95)
          continue
        }

        // 实打实命中对手
        this.gainEnergy(slot, proj.kind === 'ultra-disc' ? 16 : proj.finisher ? 15 : 10)
        if (proj.kind === 'punch-wave') {
          if (proj.finisher) {
            this.audio.playHeavyImpact()
            this.showFighterBanner(slot, 'bannerTriple', 0.9)
          } else {
            this.audio.playPunch(true)
          }
          this.inflictDamage(
            slot,
            defSlot,
            proj.damage,
            proj.finisher ? '#fef08a' : '#fde047',
            !!proj.finisher,
          )
        } else if (proj.kind === 'kick-wave') {
          this.audio.playHeavyImpact()
          this.inflictDamage(slot, defSlot, proj.damage, '#fb923c', true)
        } else if (proj.kind === 'ultra-disc') {
          this.audio.playHeavyImpact()
          this.inflictDamage(slot, defSlot, proj.damage, '#67e8f9', true)
        }
      }
    }
  }

  private updateCameras(dt: number) {
    const aspect = this.getSlotAspect()
    const wideFactor = THREE.MathUtils.clamp((aspect - 0.68) / 0.72, 0, 1)

    if (this.phase === 'menu') {
      // 整备菜单全屏单镜头：侧面史诗广角对峙，自适应宽高比将双雄完整收拢在中央安全区
      const cam = this.cameras[0]
      const sway = Math.sin(this.elapsedTime * 0.55) * 0.65
      const menuWide = THREE.MathUtils.clamp((aspect - 1.1) / 0.68, 0, 1)
      const menuDistX = THREE.MathUtils.lerp(28.5, 22.8, menuWide)
      const targetPos = new THREE.Vector3(menuDistX, 9.8, sway * 1.1)
      const targetLook = new THREE.Vector3(0, 7.5, 0)
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

      const targetCam = new THREE.Vector3()
      const targetLook = new THREE.Vector3()

      if (this.phase === 'match-over' && this.matchWinner === slot) {
        targetCam.set(s * 3.2, 9.2, s * 22.5)
        targetLook.copy(f.hero.root.position).add(new THREE.Vector3(0, 7, 0))
      } else if (this.beamClashActive) {
        // 对波时两侧玩家各自从斜后侧方广角观看己方发波、中央碰撞星芒与远端对手
        const clashSideX = s * THREE.MathUtils.lerp(15.8, 19.5, wideFactor)
        targetCam.set(clashSideX, 11.2, s * 9.2)
        targetLook.set(0, 8.8, -s * 0.8)
      } else if (f.effects.isHeroBeamActive()) {
        const armSign = f.gestureBeamArmSide === 'left' ? -1 : 1
        const beamOffsetX = s * armSign * THREE.MathUtils.lerp(3.0, 6.8, wideFactor)
        targetCam.set(f.hero.currentX * 0.45 + beamOffsetX, 10.8, s * 17.8)
        targetLook.set(opp.hero.currentX * 0.5, 9.0, opp.hero.worldZ * 0.45)
      } else {
        // 对称第三人称越肩视角：己方居左前景、对面奥特曼全身居右中景，零肩膀遮挡
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

  private renderSplitViews() {
    const w = this.fullWidth
    const h = this.fullHeight

    if (this.phase === 'menu') {
      this.renderer.setScissorTest(false)
      this.renderer.setViewport(0, 0, w, h)
      this.renderer.render(this.scene, this.cameras[0])
      return
    }

    this.renderer.setScissorTest(true)
    if (this.portraitSplit) {
      // 竖屏上下分屏：上半屏 P1（WebGL y = halfH），下半屏 P2（WebGL y = 0）
      const halfH = Math.floor(h * 0.5)
      const topH = h - halfH
      this.renderer.setViewport(0, halfH, w, topH)
      this.renderer.setScissor(0, halfH, w, topH)
      this.renderer.render(this.scene, this.cameras[0])

      this.renderer.setViewport(0, 0, w, halfH)
      this.renderer.setScissor(0, 0, w, halfH)
      this.renderer.render(this.scene, this.cameras[1])
    } else {
      // 横屏左右分屏：左半屏 P1，右半屏 P2
      const halfW = Math.floor(w * 0.5)
      const rightW = w - halfW
      this.renderer.setViewport(0, 0, halfW, h)
      this.renderer.setScissor(0, 0, halfW, h)
      this.renderer.render(this.scene, this.cameras[0])

      this.renderer.setViewport(halfW, 0, rightW, h)
      this.renderer.setScissor(halfW, 0, rightW, h)
      this.renderer.render(this.scene, this.cameras[1])
    }
  }

  private buildFighterHud(slot: PvpSlot): PvpFighterHud {
    const f = this.fighters[slot]
    const opp = this.fighters[(1 - slot) as PvpSlot]
    let chargeKind: PvpFighterHud['chargeKind'] = null
    let chargeProgress = 0
    if (this.isFighterGuarding(slot)) {
      chargeKind = 'guard'
      chargeProgress = 1
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
      energy: Math.round(f.energy),
      combo: f.combo,
      maxCombo: f.maxCombo,
      perfectGuards: f.perfectGuards,
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
      tracking: f.gestureTracking,
      bodyCoverage: f.gestureCoverage,
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
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
