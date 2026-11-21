import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { UltraAudio } from '../ultraman/audio'
import { UltraGestureRecognizer } from '../ultraman/gesture'
import { HERO_PROFILES } from '../ultraman/heroes'
import type { HeroProfile } from '../ultraman/heroes'
import type { PoseLandmark } from '../ultraman/types'
import { DuelCpu } from './ai'
import type { CpuWorldView } from './ai'
import { DuelEffects } from './effects'
import type { BeamFrameInput } from './effects'
import { DuelFighter } from './fighter'
import { ARENA_HALF_X, DuelStage } from './stage'
import type {
  DuelHudState,
  DuelMode,
  DuelPhase,
  FighterSource,
  FloatingDamageEvent,
  PlayerSlot,
} from './types'

export interface DuelEngineCallbacks {
  onHudUpdate: (state: DuelHudState) => void
  onFloatingText: (evt: FloatingDamageEvent) => void
}

interface FighterRuntime {
  slot: PlayerSlot
  fighter: DuelFighter
  profile: HeroProfile
  source: FighterSource
  recognizer: UltraGestureRecognizer | null
  /** 期望站位（移动 + 击退都写在这里，fighter 负责平滑跟随） */
  desiredX: number
  /** 击退速度（指数衰减） */
  knockVX: number
  /** 原始防御输入（体感 guard / 键盘长按） */
  guarding: boolean
  /** 本帧生效防御（含体感超时判定） */
  guardActive: boolean
  manualMove: number
  manualGuard: boolean
  manualJumpUntil: number
  hp: number
  energy: number
  combo: number
  comboTimer: number
  score: number
  punchCd: number
  kickCd: number
  discCd: number
  beamCd: number
  beamActive: boolean
  beamTicksLeft: number
  beamTickTimer: number
  beamIsSuper: boolean
  // 体感槽位 HUD 状态
  tracking: boolean
  coverage: 'none' | 'upper' | 'full'
  hintKey: string
  beamCharge: number
  discCharge: number
  discSide: 'left' | 'right' | null
  beamArmSide: 'left' | 'right'
  /** 最近一帧体感 lean 与其时间戳（超时未刷新则视为停止移动） */
  lastLean: number
  lastLeanAt: number
}

const MAX_HP = 120
const ROUND_TIME = 75
const WINS_TO_MATCH = 2
const WALK_SPEED = 8.2
const MIN_GAP = 4.6
const PUNCH_REACH = 9.6
const KICK_REACH = 11.4
const PUNCH_DAMAGE = 7
const KICK_DAMAGE = 13
const DISC_DAMAGE = 16
const DISC_ENERGY = 25
const BEAM_ENERGY = 60
const BEAM_TICK_DAMAGE = 9
const BEAM_SUPER_TICK_DAMAGE = 14
const JUMP_DODGE_HEIGHT = 3.2

/**
 * 奥特曼横版体感格斗主引擎：
 * 单镜头双人姿态识别对轰（P1 迪迦 / P2 赛罗），单人时 P2 由 CPU 接管，
 * 键盘模式双人对战；三回合两胜制，格斗 + 光轮 + 光线全部可用
 */
export class UltramanDuelEngine {
  private readonly container: HTMLElement
  private readonly callbacks: DuelEngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly loader = new GLTFLoader()
  private readonly resizeObserver: ResizeObserver

  public readonly audio = new UltraAudio()
  private readonly stage: DuelStage
  private readonly effects: DuelEffects
  private readonly fighters: [FighterRuntime, FighterRuntime]
  private readonly cpu = new DuelCpu(1)

  private rafId = 0
  private lastTimestamp = 0
  private elapsedTime = 0
  private disposed = false
  private assetsReady = false

  // 对战状态机
  private phase: DuelPhase = 'menu'
  private mode: DuelMode = 'duel'
  private loadingProgress = 0
  private round = 1
  private wins: [number, number] = [0, 0]
  private roundTimeLeft = ROUND_TIME
  private introTimer = 0
  private koTimer = 0
  private timeUpWinBannerPending = false
  private winnerSlot: PlayerSlot | null = null
  private winnerVictoryDelay = 0

  // 打击感：顿帧 + trauma² 震动 + KO 慢动作
  private hitStopTimer = 0
  private shakeTrauma = 0
  private slowMoTimer = 0
  private bannerKey: string | null = null
  private bannerTimer = 0
  private floatingIdCounter = 1
  private hudSyncAccumulator = 0

  constructor(container: HTMLElement, callbacks: DuelEngineCallbacks) {
    this.container = container
    this.callbacks = callbacks

    this.scene = new THREE.Scene()
    const w = Math.max(1, container.clientWidth || window.innerWidth)
    const h = Math.max(1, container.clientHeight || window.innerHeight)

    this.camera = new THREE.PerspectiveCamera(46, w / h, 0.5, 450)
    this.camera.position.set(0, 11.2, 34)
    this.camera.lookAt(0, 8.8, 0)

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

    this.stage = new DuelStage(this.scene)
    this.effects = new DuelEffects(this.scene)

    const tigaProfile = HERO_PROFILES.tiga
    const zeroProfile = HERO_PROFILES.zero
    const makeRuntime = (
      slot: PlayerSlot,
      profile: HeroProfile,
      startX: number,
      facing: 1 | -1,
    ): FighterRuntime => ({
      slot,
      fighter: new DuelFighter(this.scene, startX, facing),
      profile,
      source: 'camera',
      recognizer: new UltraGestureRecognizer(),
      desiredX: startX,
      knockVX: 0,
      guarding: false,
      guardActive: false,
      manualMove: 0,
      manualGuard: false,
      manualJumpUntil: 0,
      hp: MAX_HP,
      energy: 40,
      combo: 0,
      comboTimer: 0,
      score: 0,
      punchCd: 0,
      kickCd: 0,
      discCd: 0,
      beamCd: 0,
      beamActive: false,
      beamTicksLeft: 0,
      beamTickTimer: 0,
      beamIsSuper: false,
      tracking: false,
      coverage: 'none',
      hintKey: 'hintStandCenter',
      beamCharge: 0,
      discCharge: 0,
      discSide: null,
      beamArmSide: 'right',
      lastLean: 0,
      lastLeanAt: -Infinity,
    })
    this.fighters = [
      makeRuntime(0, tigaProfile, -9, 1),
      makeRuntime(1, zeroProfile, 9, -1),
    ]
    this.applyProfileTheme(0)
    this.applyProfileTheme(1)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.lastTimestamp = performance.now()
    this.loop(this.lastTimestamp)
  }

  private other(slot: PlayerSlot): PlayerSlot {
    return slot === 0 ? 1 : 0
  }

  private rt(slot: PlayerSlot): FighterRuntime {
    return this.fighters[slot]!
  }

  private applyProfileTheme(slot: PlayerSlot) {
    const rt = this.rt(slot)
    this.effects.setBeamColor(slot, rt.profile.beamColor)
    this.effects.setDiscColor(slot, rt.profile.discColor)
  }

  private handleResize() {
    if (this.disposed) return
    const w = Math.max(1, this.container.clientWidth || window.innerWidth)
    const h = Math.max(1, this.container.clientHeight || window.innerHeight)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  /** 预加载迪迦 + 赛罗双模型（进入页面即静默预载） */
  public async preloadDualAssets(): Promise<void> {
    if (this.assetsReady) return
    this.loadingProgress = 12
    this.emitHud()

    await this.fighters[0]!.fighter.load(this.loader, this.fighters[0]!.profile)
    this.loadingProgress = 58
    this.emitHud()

    await this.fighters[1]!.fighter.load(this.loader, this.fighters[1]!.profile)
    this.loadingProgress = 100
    this.assetsReady = true
    this.emitHud()
  }

  public async startGame(mode: DuelMode, opts?: { keyboardP1?: boolean }): Promise<void> {
    this.mode = mode
    this.audio.unlock()
    this.effects.clearAllDynamic()

    this.phase = 'loading'
    this.loadingProgress = this.assetsReady ? 80 : 15
    this.emitHud()

    if (!this.assetsReady) {
      await this.preloadDualAssets()
    }

    // 槽位输入源：solo = P1 摄像头 + P2 CPU；duel = 双摄像头；keyboard = 双键盘
    // keyboardP1：solo 模式摄像头不可用时的兜底（P1 键盘 + P2 CPU 键盘单挑）
    const sources: [FighterSource, FighterSource] =
      mode === 'solo'
        ? [opts?.keyboardP1 ? 'keyboard' : 'camera', 'cpu']
        : mode === 'duel'
          ? ['camera', 'camera']
          : ['keyboard', 'keyboard']
    this.fighters[0]!.source = sources[0]
    this.fighters[1]!.source = sources[1]
    this.fighters[0]!.recognizer?.reset()
    this.fighters[1]!.recognizer?.reset()
    this.cpu.reset()

    this.wins = [0, 0]
    this.round = 1
    this.fighters[0]!.score = 0
    this.fighters[1]!.score = 0
    this.audio.playTransform()
    this.startRound()
  }

  private startRound() {
    const rt0 = this.rt(0)
    const rt1 = this.rt(1)
    rt0.hp = MAX_HP
    rt1.hp = MAX_HP
    rt0.energy = 40
    rt1.energy = 40
    rt0.combo = 0
    rt1.combo = 0
    rt0.knockVX = 0
    rt1.knockVX = 0
    rt0.beamActive = false
    rt1.beamActive = false
    rt0.beamTicksLeft = 0
    rt1.beamTicksLeft = 0
    rt0.desiredX = -9
    rt1.desiredX = 9
    rt0.manualMove = 0
    rt1.manualMove = 0
    rt0.manualGuard = false
    rt1.manualGuard = false
    this.effects.clearAllDynamic()
    rt0.fighter.resetRound(-9, 1)
    rt1.fighter.resetRound(9, -1)
    this.cpu.reset()
    this.roundTimeLeft = ROUND_TIME
    this.timeUpWinBannerPending = false
    this.winnerSlot = null
    this.phase = 'round-intro'
    this.introTimer = 2.0
    this.showBanner(this.wins[0] === WINS_TO_MATCH - 1 && this.wins[1] === WINS_TO_MATCH - 1 ? 'bannerFinalRound' : 'bannerRound', 1.2)
    this.addTrauma(0.3)
    this.emitHud()
  }

  public stopToMenu() {
    this.phase = 'menu'
    this.slowMoTimer = 0
    this.effects.clearAllDynamic()
    this.rt(0).fighter.resetRound(-4, 1)
    this.rt(1).fighter.resetRound(4, -1)
    this.rt(0).beamActive = false
    this.rt(1).beamActive = false
    this.emitHud()
  }

  public setMuted(muted: boolean) {
    this.audio.muted = muted
  }

  // ---- 体感输入（每槽位独立识别器） ----

  public feedPoseFrame(
    slot: PlayerSlot,
    landmarks: PoseLandmark[] | null,
    worldLandmarks: PoseLandmark[] | null,
    now: number,
    width: number,
    height: number,
  ) {
    const rt = this.rt(slot)
    if (rt.source !== 'camera' || !rt.recognizer) return
    const snap = rt.recognizer.update(landmarks, now, width, height, worldLandmarks)
    rt.tracking = snap.tracking
    rt.coverage = snap.coverage
    rt.hintKey = snap.hintKey
    rt.beamCharge = snap.beamCharge
    rt.discCharge = snap.discCharge
    rt.discSide = snap.discSide
    rt.beamArmSide = snap.beamArmSide
    rt.guarding = snap.guard
    rt.lastLean = snap.tracking ? snap.lean : 0
    rt.lastLeanAt = snap.tracking ? now : rt.lastLeanAt
    rt.fighter.setLiveBodyPose(snap.livePose, now)

    if (this.phase !== 'fighting') return
    if (snap.punch) this.tryAttack(slot, 'punch', snap.punch)
    else if (snap.kick) this.tryAttack(slot, 'kick', snap.kick)
    else if (snap.discTrigger) this.tryAttack(slot, 'disc', 'right')
    else if (snap.beamTrigger) this.tryAttack(slot, 'beam', 'right')
  }

  public recenterSlot(slot: PlayerSlot) {
    this.rt(slot).recognizer?.recenter()
  }

  // ---- 键盘 / 触屏输入 ----

  public setManualMove(slot: PlayerSlot, dir: number) {
    this.rt(slot).manualMove = dir
  }

  public setManualGuard(slot: PlayerSlot, active: boolean) {
    this.rt(slot).manualGuard = active
  }

  public triggerManualJump(slot: PlayerSlot) {
    if (this.phase !== 'fighting') return
    this.rt(slot).manualJumpUntil = performance.now() + 460
  }

  public triggerManualPunch(slot: PlayerSlot, side: 'left' | 'right') {
    this.tryAttack(slot, 'punch', side)
  }

  public triggerManualKick(slot: PlayerSlot, side: 'left' | 'right') {
    this.tryAttack(slot, 'kick', side)
  }

  public triggerManualDisc(slot: PlayerSlot) {
    this.tryAttack(slot, 'disc', 'right')
  }

  public triggerManualBeam(slot: PlayerSlot) {
    this.tryAttack(slot, 'beam', 'right')
  }

  // ---- 攻击执行（体感 / 键盘 / CPU 共用同一管线） ----

  private tryAttack(slot: PlayerSlot, kind: 'punch' | 'kick' | 'disc' | 'beam', side: 'left' | 'right') {
    if (this.phase !== 'fighting') return
    const rt = this.rt(slot)
    const foeRt = this.rt(this.other(slot))
    if (rt.beamActive) return

    if (kind === 'punch' && rt.punchCd <= 0) {
      rt.punchCd = 0.26
      rt.fighter.triggerAction(side === 'left' ? 'punch-left' : 'punch-right', 0.28)
      // 出拳自带小幅突进，抵消对手被击退产生的距离拉扯，贴身连段更跟手
      rt.desiredX = THREE.MathUtils.clamp(
        rt.desiredX + rt.fighter.facing * 1.1,
        -ARENA_HALF_X,
        ARENA_HALF_X,
      )
      this.audio.playPunch(false)
      this.resolveMelee(slot, 'punch', side)
      return
    }
    if (kind === 'kick' && rt.kickCd <= 0) {
      rt.kickCd = 0.5
      rt.fighter.triggerAction(side === 'left' ? 'kick-left' : 'kick-right', 0.36)
      rt.desiredX = THREE.MathUtils.clamp(
        rt.desiredX + rt.fighter.facing * 1.5,
        -ARENA_HALF_X,
        ARENA_HALF_X,
      )
      this.audio.playPunch(false)
      this.resolveMelee(slot, 'kick', side)
      this.showBanner('bannerKick', 0.8)
      return
    }
    if (kind === 'disc' && rt.discCd <= 0) {
      if (rt.energy < DISC_ENERGY) {
        this.spawnFloatingAt(slot, 'ENERGY LOW', '#facc15', 0.9)
        return
      }
      rt.energy -= DISC_ENERGY
      rt.discCd = 1.2
      rt.fighter.setDiscCharge(0, side)
      rt.fighter.triggerAction('disc', 0.42)
      const origin = rt.fighter.getDiscOrigin(side)
      origin.y = Math.max(origin.y, 8.2)
      this.effects.spawnDisc(slot, origin, foeRt.fighter.currentX - rt.fighter.currentX, DISC_DAMAGE, rt.profile.discColor)
      this.audio.playDisc()
      this.showBanner(`bannerDisc${rt.profile.bannerKey}`, 0.9)
      this.emitHud()
      return
    }
    if (kind === 'beam' && rt.beamCd <= 0) {
      if (rt.energy < BEAM_ENERGY) {
        this.spawnFloatingAt(slot, 'ENERGY LOW', '#facc15', 0.9)
        return
      }
      const isSuper = rt.energy >= 100
      rt.energy = isSuper ? 0 : rt.energy - BEAM_ENERGY
      rt.beamCd = 2.4
      rt.beamActive = true
      rt.beamIsSuper = isSuper
      rt.beamTicksLeft = isSuper ? 7 : 5
      rt.beamTickTimer = 0.2
      rt.fighter.triggerAction('beam', isSuper ? 1.7 : 1.25)
      this.effects.resetBeamReveal(slot)
      this.audio.playBeam(isSuper)
      this.addTrauma(isSuper ? 0.6 : 0.4)
      this.showBanner(
        isSuper ? `bannerSuperBeam${rt.profile.bannerKey}` : `bannerBeam${rt.profile.bannerKey}`,
        1.2,
      )
      this.emitHud()

      // 光线期间逐步击退施法者后座
      rt.knockVX = -rt.fighter.facing * 2.4
      return
    }
  }

  /** 近战命中判定：距离 / 跳跃闪避 / 格挡 / 命中（攻击距离按含突进的意图位计算） */
  private resolveMelee(slot: PlayerSlot, kind: 'punch' | 'kick', side: 'left' | 'right') {
    const rt = this.rt(slot)
    const foe = this.rt(this.other(slot))
    const ax = rt.desiredX
    const vx = foe.fighter.currentX
    const dist = Math.abs(ax - vx)
    const reach = kind === 'punch' ? PUNCH_REACH : KICK_REACH
    const origin = kind === 'punch' ? rt.fighter.getFistOrigin(side) : rt.fighter.getFootOrigin(side)
    const contact = origin.clone().lerp(foe.fighter.getCenter(), 0.45)

    if (dist > reach || foe.fighter.getAction() === 'ko') return

    if (foe.fighter.getJumpHeight() > JUMP_DODGE_HEIGHT) {
      foe.energy = Math.min(100, foe.energy + 6)
      this.spawnFloatingAt(foe.slot, 'DODGE!', '#4ade80', 1.05)
      this.emitHud()
      return
    }

    const baseDamage = kind === 'punch' ? PUNCH_DAMAGE : KICK_DAMAGE
    if (foe.guarding) {
      foe.energy = Math.min(100, foe.energy + 10)
      foe.hp = Math.max(0, foe.hp - (kind === 'punch' ? 1 : 2))
      foe.knockVX = Math.sign(vx - ax) * 3.2
      this.effects.triggerShieldFlash(foe.slot)
      this.audio.playGuardBlock()
      this.spawnFloatingAt(foe.slot, 'GUARD', '#38bdf8', 1.0)
      this.addHitStop(0.03)
      this.addTrauma(0.16)
      this.checkRoundEnd(foe.slot)
      this.emitHud()
      return
    }

    this.applyHit(slot, foe, baseDamage, kind === 'punch' ? 'light' : 'heavy', contact)
  }

  /** 通用命中结算（近战 / 光轮 / 光线 tick 共用） */
  private applyHit(
    attackerSlot: PlayerSlot,
    foe: FighterRuntime,
    damage: number,
    impact: 'light' | 'heavy' | 'beam',
    contactPos: THREE.Vector3,
  ) {
    const attacker = this.rt(attackerSlot)
    foe.hp = Math.max(0, foe.hp - damage)
    foe.combo = 0
    foe.comboTimer = 0
    attacker.combo += 1
    attacker.comboTimer = 3
    attacker.score += damage * 10 + attacker.combo * 5
    attacker.energy = Math.min(100, attacker.energy + 6)
    foe.energy = Math.min(100, foe.energy + 8)
    foe.knockVX = Math.sign(foe.fighter.currentX - attacker.fighter.currentX) * (impact === 'light' ? 4.2 : 6.4)
    foe.fighter.triggerAction('hit', 0.4)

    const colorHex = attacker.profile.beamColor
    this.effects.spawnBurst(contactPos, colorHex, impact === 'light' ? 10 : 16, 20, 0.9)
    this.effects.spawnImpactRing(contactPos, 0xffffff, impact === 'light' ? 5.5 : 8.5)
    this.effects.spawnHitFlash(contactPos, 0xffffff, impact === 'light' ? 1.0 : 1.3)

    if (impact === 'heavy') {
      this.addHitStop(0.085)
      this.addTrauma(0.42)
      this.audio.playHeavyImpact()
    } else if (impact === 'light') {
      this.addHitStop(0.05)
      this.addTrauma(0.26)
      this.audio.playPunch(true)
    } else {
      this.addTrauma(0.12)
      this.audio.playPunch(true)
    }

    this.spawnFloatingAt(
      foe.slot,
      `-${damage}`,
      attackerSlot === 0 ? '#fde047' : '#fb923c',
      impact === 'light' ? 1.0 : 1.25,
    )
    this.checkRoundEnd(foe.slot)
    this.emitHud()
  }

  /** 光线持续 tick 伤害（跳跃可躲、格挡减伤） */
  private applyBeamTick(slot: PlayerSlot) {
    const rt = this.rt(slot)
    const foe = this.rt(this.other(slot))
    if (foe.fighter.getAction() === 'ko') return
    if (foe.fighter.getJumpHeight() > JUMP_DODGE_HEIGHT) return

    const contact = foe.fighter.getCenter().clone()
    if (foe.guarding) {
      foe.hp = Math.max(0, foe.hp - (rt.beamIsSuper ? 4 : 2))
      foe.energy = Math.min(100, foe.energy + 5)
      this.effects.triggerShieldFlash(foe.slot)
      this.spawnFloatingAt(foe.slot, 'GUARD', '#38bdf8', 0.85)
      this.checkRoundEnd(foe.slot)
      this.emitHud()
      return
    }
    this.applyHit(slot, foe, rt.beamIsSuper ? BEAM_SUPER_TICK_DAMAGE : BEAM_TICK_DAMAGE, 'beam', contact)
    foe.knockVX = Math.sign(foe.fighter.currentX - rt.fighter.currentX) * 5.5
  }

  /** 回合终结检测：hp 归零即 KO */
  private checkRoundEnd(loserSlot: PlayerSlot) {
    if (this.phase !== 'fighting') return
    const loser = this.rt(loserSlot)
    if (loser.hp > 0) return

    const winnerSlot = this.other(loserSlot)
    this.winnerSlot = winnerSlot
    this.wins[winnerSlot] += 1
    this.rt(winnerSlot).score += 1200
    this.phase = 'ko'
    this.koTimer = 3.1
    this.slowMoTimer = 1.0
    this.winnerVictoryDelay = 1.4

    loser.fighter.triggerAction('ko', 99)
    loser.beamActive = false
    loser.beamTicksLeft = 0
    this.audio.playExplosion()
    this.addHitStop(0.12)
    this.addTrauma(0.95)
    this.effects.spawnKoExplosion(loser.fighter.getCenter(), this.rt(winnerSlot).profile.beamColor)
    this.showBanner(`bannerRoundWinP${winnerSlot + 1}`, 2.2)
    this.emitHud()
  }

  /** 回合时间耗尽：血量高者胜，完全相同则平局重赛 */
  private onRoundTimeUp() {
    const rt0 = this.rt(0)
    const rt1 = this.rt(1)
    this.phase = 'ko'
    this.koTimer = 2.8
    if (rt0.hp === rt1.hp) {
      this.winnerSlot = null
      this.showBanner('bannerDraw', 1.8)
    } else {
      const winnerSlot: PlayerSlot = rt0.hp > rt1.hp ? 0 : 1
      this.winnerSlot = winnerSlot
      this.wins[winnerSlot] += 1
      this.rt(winnerSlot).score += 800
      this.winnerVictoryDelay = 0.9
      this.timeUpWinBannerPending = true
      this.showBanner('bannerTimeUp', 1.2)
    }
    this.emitHud()
  }

  private showBanner(key: string, duration: number) {
    this.bannerKey = key
    this.bannerTimer = duration
  }

  private addTrauma(amount: number) {
    this.shakeTrauma = Math.min(1.15, this.shakeTrauma + amount)
  }

  private addHitStop(seconds: number) {
    this.hitStopTimer = Math.max(this.hitStopTimer, seconds)
  }

  private spawnFloatingAt(slot: PlayerSlot, text: string, color: string, scale = 1) {
    const rt = this.rt(slot)
    const worldPos = rt.fighter.root.position.clone().add(new THREE.Vector3(0, 15.5, 0))
    const projected = worldPos.clone().project(this.camera)
    const x = THREE.MathUtils.clamp((projected.x * 0.5 + 0.5) * 100, 12, 88)
    const y = THREE.MathUtils.clamp((-projected.y * 0.5 + 0.5) * 100, 14, 82)
    this.callbacks.onFloatingText({
      id: this.floatingIdCounter++,
      slot,
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

    let dt = rawDt
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= rawDt
      dt = rawDt * 0.12
    }
    if (this.slowMoTimer > 0) {
      this.slowMoTimer -= rawDt
      dt *= 0.35
    }

    this.stepSimulation(dt, rawDt, now)
    this.renderer.render(this.scene, this.camera)
  }

  private stepSimulation(dt: number, rawDt: number, nowMs: number) {
    const rt0 = this.rt(0)
    const rt1 = this.rt(1)

    // 冷却与计时
    for (const rt of this.fighters) {
      if (rt.punchCd > 0) rt.punchCd = Math.max(0, rt.punchCd - dt)
      if (rt.kickCd > 0) rt.kickCd = Math.max(0, rt.kickCd - dt)
      if (rt.discCd > 0) rt.discCd = Math.max(0, rt.discCd - dt)
      if (rt.beamCd > 0) rt.beamCd = Math.max(0, rt.beamCd - dt)
      if (rt.combo > 0) {
        rt.comboTimer -= dt
        if (rt.comboTimer <= 0) rt.combo = 0
      }
      if (rt.knockVX !== 0) {
        rt.knockVX *= Math.exp(-dt * 5.2)
        if (Math.abs(rt.knockVX) < 0.12) rt.knockVX = 0
      }
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer = Math.max(0, this.bannerTimer - dt)
      if (this.bannerTimer <= 0) this.bannerKey = null
    }

    // 回合阶段推进
    if (this.phase === 'round-intro') {
      this.introTimer -= dt
      if (this.introTimer <= 0) {
        this.phase = 'fighting'
        this.showBanner('bannerFight', 0.9)
        this.effects.spawnImpactRing(new THREE.Vector3(0, 9, 0), 0xfacc15, 12)
        this.addTrauma(0.3)
        this.emitHud()
      }
    } else if (this.phase === 'fighting') {
      this.roundTimeLeft = Math.max(0, this.roundTimeLeft - dt)
      if (this.roundTimeLeft <= 0) {
        this.onRoundTimeUp()
      }
    } else if (this.phase === 'ko') {
      this.koTimer -= dt
      // 时间耗尽的回合先报 TIME UP，再补报回合胜者
      if (this.timeUpWinBannerPending && this.bannerTimer <= 0) {
        this.timeUpWinBannerPending = false
        if (this.winnerSlot !== null) {
          this.showBanner(`bannerRoundWinP${this.winnerSlot + 1}`, 1.4)
        }
      }
      if (this.winnerVictoryDelay > 0) {
        this.winnerVictoryDelay -= dt
        if (this.winnerVictoryDelay <= 0 && this.winnerSlot !== null) {
          this.rt(this.winnerSlot).fighter.triggerAction('victory', 5)
          this.audio.playVictory()
        }
      }
      if (this.koTimer <= 0) {
        if (this.winnerSlot !== null && this.wins[this.winnerSlot] >= WINS_TO_MATCH) {
          this.phase = 'match-end'
          this.winnerVictoryDelay = 0
          this.showBanner(`bannerMatchWinP${this.winnerSlot + 1}`, 4)
          this.emitHud()
        } else {
          this.round += 1
          this.startRound()
        }
      }
    }

    // ---- 输入合成（体感 lean / 键盘 / CPU） ----
    const cameraActive = this.phase === 'fighting' || this.phase === 'round-intro'
    for (const rt of this.fighters) {
      let move = 0
      let guarding = false
      if (rt.source === 'camera' && cameraActive) {
        // 体感 lean 超时未刷新（识别丢失）则停止移动，防止持续走位
        move = nowMs - rt.lastLeanAt < 700 ? rt.lastLean : 0
        guarding = nowMs - rt.lastLeanAt < 700 && rt.guarding
      } else if (rt.source === 'keyboard') {
        move = rt.manualMove
        guarding = rt.manualGuard
      }
      if (rt.beamActive) move = 0
      rt.guardActive = guarding

      // 期望位移：走位 + 击退
      rt.desiredX = THREE.MathUtils.clamp(
        rt.desiredX + move * WALK_SPEED * dt + rt.knockVX * dt,
        -ARENA_HALF_X,
        ARENA_HALF_X,
      )
      const manualJump = nowMs < rt.manualJumpUntil
      rt.fighter.setManualJump(manualJump)
      rt.fighter.setGuard(guarding)
      rt.fighter.setTargetX(rt.desiredX)
    }

    // 双人不可重叠：间距不足则对称推开
    const gap = rt1.fighter.currentX - rt0.fighter.currentX
    if (Math.abs(gap) < MIN_GAP) {
      const push = (MIN_GAP - Math.abs(gap)) / 2
      const dir = gap >= 0 ? 1 : -1
      rt0.desiredX = THREE.MathUtils.clamp(rt0.desiredX - dir * push, -ARENA_HALF_X, ARENA_HALF_X)
      rt1.desiredX = THREE.MathUtils.clamp(rt1.desiredX + dir * push, -ARENA_HALF_X, ARENA_HALF_X)
      rt0.fighter.setTargetX(rt0.desiredX)
      rt1.fighter.setTargetX(rt1.desiredX)
    }

    // 面朝对手（横版格斗经典自动转身）
    rt0.fighter.setFacing(rt0.fighter.currentX <= rt1.fighter.currentX ? 1 : -1)
    rt1.fighter.setFacing(rt1.fighter.currentX < rt0.fighter.currentX ? 1 : -1)

    // CPU 决策（仅 fighting）
    if (this.phase === 'fighting' && rt1.source === 'cpu') {
      const foeDiscIncoming = this.effects.projectiles.some(
        (p) => p.fromSlot === 0 && Math.abs(p.pos.x - rt1.fighter.currentX) < 14 && p.vel.x > 0,
      )
      const world: CpuWorldView = {
        self: {
          x: rt1.fighter.currentX,
          hp: rt1.hp,
          energy: rt1.energy,
          airborne: rt1.fighter.isAirborne(),
          beamActive: rt1.beamActive,
        },
        foe: {
          x: rt0.fighter.currentX,
          hp: rt0.hp,
          airborne: rt0.fighter.isAirborne(),
          guarding: rt0.guarding,
          beamActive: rt0.beamActive,
          discIncoming: foeDiscIncoming,
        },
        distance: Math.abs(rt1.fighter.currentX - rt0.fighter.currentX),
      }
      const cmd = this.cpu.tick(dt, nowMs, world)
      if (cmd.punch) this.tryAttack(1, 'punch', cmd.punch)
      else if (cmd.kick) this.tryAttack(1, 'kick', cmd.kick)
      else if (cmd.discTrigger) this.tryAttack(1, 'disc', 'right')
      else if (cmd.beamTrigger) this.tryAttack(1, 'beam', 'right')
      rt1.manualMove = cmd.move
      rt1.manualGuard = cmd.guard
      if (cmd.manualJumpUntil > nowMs) rt1.manualJumpUntil = cmd.manualJumpUntil
    }

    // 光线持续伤害 tick
    for (const rt of this.fighters) {
      if (!rt.beamActive) continue
      rt.beamTickTimer -= dt
      if (rt.beamTickTimer <= 0) {
        rt.beamTickTimer = 0.22
        rt.beamTicksLeft -= 1
        this.applyBeamTick(rt.slot)
        if (rt.beamTicksLeft <= 0) {
          rt.beamActive = false
          this.emitHud()
        }
      }
    }

    // 光轮抛射物命中
    for (let i = this.effects.projectiles.length - 1; i >= 0; i--) {
      const proj = this.effects.projectiles[i]!
      if (proj.hitTriggered) continue
      const foe = this.rt(this.other(proj.fromSlot))
      if (Math.abs(proj.pos.x - foe.fighter.currentX) < 3.0) {
        if (foe.fighter.getAction() === 'ko') continue
        if (foe.fighter.getJumpHeight() > JUMP_DODGE_HEIGHT) {
          // 跳跃躲过光轮，光轮继续飞行
          continue
        }
        proj.hitTriggered = true
        const contact = foe.fighter.getCenter()
        if (foe.guarding) {
          foe.hp = Math.max(0, foe.hp - 3)
          foe.energy = Math.min(100, foe.energy + 10)
          foe.knockVX = Math.sign(foe.fighter.currentX - proj.pos.x) * 4.6
          this.effects.triggerShieldFlash(foe.slot)
          this.audio.playGuardBlock()
          this.spawnFloatingAt(foe.slot, 'GUARD', '#38bdf8', 1.0)
          this.checkRoundEnd(foe.slot)
          this.emitHud()
        } else {
          this.applyHit(proj.fromSlot, foe, proj.damage, 'heavy', contact)
        }
      }
    }

    // fighters 与场景更新
    const danger0 = this.phase === 'fighting' && rt0.hp <= MAX_HP * 0.3
    const danger1 = this.phase === 'fighting' && rt1.hp <= MAX_HP * 0.3
    rt0.fighter.update(dt, this.elapsedTime, danger0, nowMs)
    rt1.fighter.update(dt, this.elapsedTime, danger1, nowMs)
    this.stage.update(dt, this.elapsedTime)

    // 特效：光线（双人对轰可同时存在）
    const beamInputs: [BeamFrameInput | null, BeamFrameInput | null] = [
      this.buildBeamInput(rt0, rt1),
      this.buildBeamInput(rt1, rt0),
    ]
    this.effects.updateBeams(dt, this.elapsedTime, beamInputs)

    for (const rt of this.fighters) {
      this.effects.updateShield(
        rt.slot,
        rt.guardActive,
        rt.fighter.currentX,
        rt.fighter.facing,
        dt,
        this.elapsedTime,
      )
      const showCharge = rt.source === 'camera' && this.phase === 'fighting'
      this.effects.updateChargePreview(
        rt.slot,
        showCharge ? rt.beamCharge : 0,
        rt.fighter.getBeamOriginSegment()[0].clone().lerp(rt.fighter.getBeamOriginSegment()[1], 0.55),
        showCharge ? rt.discCharge : 0,
        rt.fighter.getDiscOrigin(rt.discSide ?? 'right'),
        this.elapsedTime,
      )
      this.effects.updateGroundMarker(
        rt.slot,
        rt.fighter.currentX,
        this.elapsedTime,
        rt.hp <= MAX_HP * 0.3,
      )
    }
    this.effects.update(dt)

    this.updateCamera(rawDt)

    this.hudSyncAccumulator += dt
    if (this.hudSyncAccumulator >= 0.08) {
      this.hudSyncAccumulator = 0
      this.emitHud()
    }
  }

  private buildBeamInput(rt: FighterRuntime, foe: FighterRuntime): BeamFrameInput | null {
    if (!rt.beamActive) return null
    return {
      segment: rt.fighter.getBeamOriginSegment(),
      target: foe.fighter.getCenter(),
      isSuper: rt.beamIsSuper,
    }
  }

  private updateCamera(dt: number) {
    const rt0 = this.rt(0)
    const rt1 = this.rt(1)
    const mid = (rt0.fighter.currentX + rt1.fighter.currentX) / 2
    const sep = Math.abs(rt0.fighter.currentX - rt1.fighter.currentX)

    const targetCam = new THREE.Vector3(mid * 0.86, 11.4, 30 + sep * 0.62)
    const targetLook = new THREE.Vector3(mid * 0.92, 8.8, 0)

    if (this.phase === 'match-end' && this.winnerSlot !== null) {
      const winner = this.rt(this.winnerSlot)
      targetCam.set(winner.fighter.currentX * 0.6 + 6, 13.5, 30)
      targetLook.set(winner.fighter.currentX * 0.8, 12, 0)
    } else if (this.phase === 'ko') {
      targetCam.y += 1.2
      targetCam.z -= 3
    } else if (this.phase === 'menu') {
      targetCam.set(Math.sin(this.elapsedTime * 0.22) * 4, 11.2, 33)
    }

    this.camera.position.lerp(targetCam, Math.min(1, dt * 6))

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

  public getHudSnapshot(): DuelHudState {
    const rt0 = this.rt(0)
    const rt1 = this.rt(1)
    const chargeKindOf = (rt: FighterRuntime): 'beam' | 'disc' | 'guard' | null => {
      if (rt.guarding) return 'guard'
      if (rt.beamCharge > 0.05) return 'beam'
      if (rt.discCharge > 0.05) return 'disc'
      return null
    }
    return {
      phase: this.phase,
      loadingProgress: this.loadingProgress,
      mode: this.mode,
      round: this.round,
      wins: [this.wins[0], this.wins[1]],
      roundTimeLeft: Math.ceil(this.roundTimeLeft),
      hp: [Math.round(rt0.hp), Math.round(rt1.hp)],
      maxHp: MAX_HP,
      energy: [Math.round(rt0.energy), Math.round(rt1.energy)],
      combo: [rt0.combo, rt1.combo],
      score: [Math.round(rt0.score), Math.round(rt1.score)],
      sources: [rt0.source, rt1.source],
      tracking: [rt0.tracking, rt1.tracking],
      bodyCoverage: [rt0.coverage, rt1.coverage],
      poseHintKey: [rt0.hintKey, rt1.hintKey],
      dangerTimer: [
        this.phase === 'fighting' && rt0.hp <= MAX_HP * 0.3,
        this.phase === 'fighting' && rt1.hp <= MAX_HP * 0.3,
      ],
      chargeKind: [chargeKindOf(rt0), chargeKindOf(rt1)],
      chargeProgress: [
        rt0.guarding ? 1 : Math.max(rt0.beamCharge, rt0.discCharge),
        rt1.guarding ? 1 : Math.max(rt1.beamCharge, rt1.discCharge),
      ],
      activeBannerKey: this.bannerKey,
      winnerSlot: this.phase === 'match-end' ? this.winnerSlot : null,
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
    this.rt(0).fighter.dispose()
    this.rt(1).fighter.dispose()
    this.stage.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
