export type GamePhase =
  | 'menu'
  | 'loading'
  | 'intro'
  | 'fighting'
  | 'wave-clear'
  | 'victory'
  | 'defeat'

export type ControlMode = 'camera' | 'keyboard'

export type HeroAction =
  | 'idle'
  | 'punch-left'
  | 'punch-right'
  | 'guard'
  | 'disc'
  | 'beam'
  | 'hit'
  | 'victory'

export type MonsterAttackKind = 'melee' | 'fireball' | 'dark-beam'

export interface MonsterSpec {
  id: string
  modelUrl: string
  maxHp: number
  /** 归一化后的目标高度（世界单位，迪迦高度约为 13.5） */
  targetHeight: number
  /** 战斗默认站位 Z 坐标（迪迦在 Z = 20，怪兽在其正前方负 Z 方向） */
  baseZ: number
  /** 主要视觉发光色 */
  accentColor: number
  /** 攻击配置 */
  attacks: MonsterAttackKind[]
  /** 攻击基础伤害 */
  attackDamage: number
  /** 攻击冷却（秒） */
  attackInterval: number
  /** 是否为静态网格（无骨骼，如加恩Q） */
  isStaticMesh?: boolean
  /** 初始绕 Y 轴朝向修正（弧度），默认怪兽导出朝向 +Z 正对位于 +Z 侧的迪迦 */
  facingOffsetY?: number
}

export interface PoseLandmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

export interface GestureSnapshot {
  tracking: boolean
  /** 左右位移/倾身偏移 [-1, 1]，负数为左，正数为右 */
  lean: number
  /** 双臂胸前交叉防御 */
  guard: boolean
  /** 本帧触发的拳击 */
  punch: 'left' | 'right' | null
  /** 举手蓄力光轮进度 [0, 1] */
  discCharge: number
  discSide: 'left' | 'right' | null
  /** 本帧触发的八分光轮 */
  discTrigger: 'left' | 'right' | null
  /** 十字/L字光线蓄力进度 [0, 1] */
  beamCharge: number
  /** 本帧触发的哉佩利敖光线 */
  beamTrigger: boolean
  /** 提示文案键 */
  hintKey: string
}

export interface FloatingDamageEvent {
  id: number
  text: string
  color: string
  /** 屏幕百分比坐标 0~100 */
  x: number
  y: number
  scale: number
}

export interface BattleHudState {
  phase: GamePhase
  loadingProgress: number
  waveIndex: number
  totalWaves: number
  monsterId: string
  monsterHp: number
  monsterMaxHp: number
  heroHp: number
  heroMaxHp: number
  energy: number
  score: number
  combo: number
  maxCombo: number
  perfectGuards: number
  defeatedCount: number
  warningTextKey: string | null
  warningUrgency: number
  chargeKind: 'beam' | 'disc' | 'guard' | null
  chargeProgress: number
  activeSkillBannerKey: string | null
  tracking: boolean
  poseHintKey: string
  timerDanger: boolean
}
