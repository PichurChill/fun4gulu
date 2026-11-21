import type { HeroId, LiveBodyPose, PoseLandmark } from '../ultraman/types'

export type { HeroId, LiveBodyPose, PoseLandmark }

/** 对战模式：单人挑战 CPU / 双人同屏体感 / 键盘双人 */
export type DuelMode = 'solo' | 'duel' | 'keyboard'

export type DuelPhase =
  | 'menu'
  | 'loading'
  | 'round-intro'
  | 'fighting'
  | 'ko'
  | 'round-end'
  | 'match-end'

/** 玩家槽位：0 = 左侧（迪迦），1 = 右侧（赛罗） */
export type PlayerSlot = 0 | 1

export type FighterSource = 'camera' | 'keyboard' | 'cpu'

/** 单个 fighters 的离散攻击指令（体感 GestureSnapshot / 键盘 / CPU 统一抽象） */
export interface FighterCommands {
  /** 水平移动指令 [-1, 1]，负向擂台左侧 */
  move: number
  guard: boolean
  punch: 'left' | 'right' | null
  kick: 'left' | 'right' | null
  discTrigger: boolean
  beamTrigger: boolean
  /** 手动跳跃截止时间戳（ms），体感模式由 livePose.jumpHeight 直接驱动 */
  manualJumpUntil: number
}

export function emptyCommands(): FighterCommands {
  return {
    move: 0,
    guard: false,
    punch: null,
    kick: null,
    discTrigger: false,
    beamTrigger: false,
    manualJumpUntil: 0,
  }
}

/** 体感识别快照（每槽位一份，来自共享 UltraGestureRecognizer） */
export interface SlotPoseFrame {
  tracking: boolean
  coverage: 'none' | 'upper' | 'full'
  hintKey: string
  livePose: LiveBodyPose | null
  commands: FighterCommands
  beamCharge: number
  discCharge: number
}

export interface FloatingDamageEvent {
  id: number
  slot: PlayerSlot
  text: string
  color: string
  /** 屏幕百分比坐标 0~100 */
  x: number
  y: number
  scale: number
}

export interface DuelHudState {
  phase: DuelPhase
  loadingProgress: number
  mode: DuelMode
  round: number
  /** 双方回合胜利数 */
  wins: [number, number]
  /** 回合剩余秒数 */
  roundTimeLeft: number
  hp: [number, number]
  maxHp: number
  energy: [number, number]
  combo: [number, number]
  score: [number, number]
  /** 槽位控制来源（camera / keyboard / cpu） */
  sources: [FighterSource, FighterSource]
  tracking: [boolean, boolean]
  bodyCoverage: ['none' | 'upper' | 'full', 'none' | 'upper' | 'full']
  poseHintKey: [string, string]
  dangerTimer: [boolean, boolean]
  chargeKind: ['beam' | 'disc' | 'guard' | null, 'beam' | 'disc' | 'guard' | null]
  chargeProgress: [number, number]
  activeBannerKey: string | null
  /** match-end 时的胜者槽位（平局为 null） */
  winnerSlot: PlayerSlot | null
}
