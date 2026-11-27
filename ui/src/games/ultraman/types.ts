import type { MonsterState } from './encounter'
import type { HeroId } from './heroes'

export type { HeroId }

export type GamePhase =
  | 'menu'
  | 'loading'
  | 'calibrating'
  | 'transform'
  | 'intro'
  | 'fighting'
  | 'wave-clear'
  | 'victory'
  | 'defeat'

export type GameMode = 'story' | 'practice'

/** 动态战斗阶段：自由战斗为主，关键条件自然触发特摄名场面 */
export type BattleStage =
  | 'melee'
  | 'transition-ranged'
  | 'ranged'
  | 'grapple'
  | 'grapple-finish'
  | 'finisher-spread'
  | 'finisher-beam'

/** 右下角动态动作教学指令卡类型 */
export type ActionGuideKind =
  | 'transform'
  | 'punch'
  | 'guard'
  | 'dodge-shoot'
  | 'crouch-dodge'
  | 'jump-dodge'
  | 'grapple'
  | 'beam-spread'
  | 'beam-fire'
  | 'kick-break'
  | 'disc-illusion'

export type ControlMode = 'camera' | 'keyboard'

export type ConcreteSceneTheme = 'seaside' | 'city' | 'mountain' | 'volcano'
export type SceneTheme = 'auto' | ConcreteSceneTheme

export type PunchStyle = 'jab' | 'hook' | 'uppercut' | 'palm' | 'chop'
export type StrikeHeight = 'high' | 'mid' | 'low'

export type DistanceHint = 'ok' | 'too-close' | 'too-far' | 'off-center'

export type GestureActiveCue =
  | 'none'
  | 'punch-l'
  | 'punch-r'
  | 'kick'
  | 'guard'
  | 'beam'
  | 'disc'
  | 'dodge'
  | 'crouch'
  | 'jump'
  | 'spread'
  | 'transform'

export type HeroAction =
  | 'idle'
  | 'pose-intro'
  | 'transform'
  | 'punch-left'
  | 'punch-right'
  | 'hook-left'
  | 'hook-right'
  | 'uppercut-left'
  | 'uppercut-right'
  | 'chop-left'
  | 'chop-right'
  | 'punch-heavy'
  | 'combo-1'
  | 'combo-2'
  | 'combo-3'
  | 'combo-4'
  | 'combo-5'
  | 'palm-left'
  | 'palm-right'
  | 'dodge-left'
  | 'dodge-right'
  | 'crouch-dodge'
  | 'jump-kick'
  | 'kick-left'
  | 'kick-right'
  | 'guard'
  | 'guard-parry'
  | 'disc'
  | 'grapple'
  | 'grapple-throw'
  | 'backflip-land'
  | 'cinematic-taunt'
  | 'beam-spread'
  | 'beam'
  | 'hit'
  | 'hit-left'
  | 'hit-right'
  | 'hit-heavy'
  | 'defeat'
  | 'victory'

export type MonsterAttackKind =
  | 'melee'
  | 'melee-high'
  | 'melee-low'
  | 'charge'
  | 'fireball'
  | 'dark-beam'
  | 'illusion'

export interface MonsterSpec {
  id: string
  modelUrl: string
  maxHp: number
  /** 归一化后的目标高度（世界单位，奥特曼高度约为 13.5） */
  targetHeight: number
  /** 战斗默认站位 Z 坐标（奥特曼在 Z = 8.4~13.2，怪兽在其正前方负 Z 方向） */
  baseZ: number
  /** 主要视觉发光色 */
  accentColor: number
  /** 攻击配置 */
  attacks: MonsterAttackKind[]
  /** 攻击基础伤害 */
  attackDamage: number
  /** 攻击冷却（秒） */
  attackInterval: number
  /** 默认闯关时搭配的战场主题 */
  defaultTheme: ConcreteSceneTheme
  /** 命中材质类型（用于音效与火花分层） */
  armorMaterial: 'flesh' | 'metal' | 'chitin' | 'eldritch'
  /** 是否为静态网格（无骨骼） */
  isStaticMesh?: boolean
  /** 初始绕 Y 轴朝向修正（弧度） */
  facingOffsetY?: number
}

export interface PoseLandmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** 单手 21 点追踪解算出的五指独立弯曲度、张开度与真实 3D 掌心朝向 */
export interface LiveHandFingers {
  thumb: number
  index: number
  mid: number
  ring: number
  pinky: number
  /** 五指整体外展张开度 [0=并拢手刀, 1=自然张开] */
  splay: number
  /** 真实 3D 掌心朝向法线（奥特曼世界坐标） */
  palmNormal: Vec3Like | null
  /** 手掌朝向向量（手腕 -> 中指根，奥特曼世界坐标） */
  handDir: Vec3Like | null
}

/**
 * 实时全身动捕姿态包（已转换至奥特曼背影面朝 -Z 的 3D 世界方向）
 */
export interface LiveBodyPose {
  active: boolean
  /** 追踪范围：全身（含腿）或上半身 */
  coverage: 'full' | 'upper'
  /** 躯干前后俯仰角（弧度，前倾为正） */
  torsoPitch: number
  /** 躯干左右侧倾角（弧度，向画面右侧倾为负/左侧倾为正） */
  torsoRoll: number
  /** 躯干水平转肩扭腰角（弧度） */
  torsoYaw: number
  /** 头部相对躯干的左右转头与俯仰、侧歪 */
  headYaw: number
  headPitch: number
  headRoll: number
  /** 起跳高度（世界单位 >= 0）与下蹲深度（世界单位 >= 0） */
  jumpHeight: number
  crouchDepth: number
  /** 四肢骨骼实时世界方向向量（null 表示该肢体当前不可见） */
  upperArmL: Vec3Like | null
  lowerArmL: Vec3Like | null
  handL: Vec3Like | null
  upperArmR: Vec3Like | null
  lowerArmR: Vec3Like | null
  handR: Vec3Like | null
  thighL: Vec3Like | null
  shinL: Vec3Like | null
  thighR: Vec3Like | null
  shinR: Vec3Like | null
  /** 双手 21 点精细手指实时屈伸与真实掌心朝向（未检测到手部时为 null） */
  fingersL?: LiveHandFingers | null
  fingersR?: LiveHandFingers | null
  /** 摆出光线手势时竖直朝上的那一侧前臂 */
  beamArmSide: 'left' | 'right'
}

export interface GestureSnapshot {
  tracking: boolean
  coverage: 'none' | 'upper' | 'full'
  /** 客厅站距与居中校准提示 */
  distanceHint: DistanceHint
  /** 实时高亮反馈标记（供雷达肢体变色） */
  activeCue: GestureActiveCue
  /** 左右位移/倾身偏移 [-1, 1]，负数为左，正数为右 */
  lean: number
  /** 横向跨步瞬时速度（用于触发侧滑/闪步动画） */
  lateralVelocity: number
  /** 深蹲状态与深度 [0, 1]（用于闪避高位横扫） */
  crouching: boolean
  crouchDepth: number
  /** 腾空起跳状态（用于闪避低位震波） */
  jumping: boolean
  /** 双臂胸前交叉防御 */
  guard: boolean
  /** 本帧刚进入防御架势的时间戳（用于精准防御判定） */
  guardJustStarted: boolean
  /** 本帧触发的拳击 */
  punch: 'left' | 'right' | null
  /** 出拳动作风格（直拳/横摆/上勾/推掌/手刀） */
  punchStyle: PunchStyle
  /** 真实发力强度 [0.35, 1.0] */
  punchPower: number
  /** 击打高度区域（决定受击部位与反应） */
  punchHeight: StrikeHeight
  /** 本帧触发的抬腿飞踢 */
  kick: 'left' | 'right' | null
  /** 举手蓄力光轮进度 [0, 1] */
  discCharge: number
  discSide: 'left' | 'right' | null
  /** 本帧触发的光轮斩 */
  discTrigger: 'left' | 'right' | null
  /** 双手举过头顶交叉的形态切换蓄力进度 [0, 1] */
  typeCharge: number
  /** 本帧触发的形态切换 */
  typeTrigger: boolean
  /** 十字/L字光线蓄力进度 [0, 1] */
  beamCharge: number
  /** 本帧触发的必杀光线 */
  beamTrigger: boolean
  /** 是否正保持光线发射手势（用于光线对波持续推进） */
  beamHolding: boolean
  /** 光线发射时的主竖臂侧 */
  beamArmSide: 'left' | 'right'
  /** 单手高举神光棒变身进度 [0, 1] */
  transformProgress: number
  /** 本帧变身完成触发 */
  transformTrigger: boolean
  /** 双臂平展蓄力进度 [0, 1] */
  spreadProgress: number
  /** 当前是否保持双臂展开蓄力姿态 */
  isSpreading: boolean
  /** 角力阶段摆臂/原地快跑推力脉冲强度 [0, 1] */
  strugglePower: number
  /** 归一化站位水平比例 [0, 1]（镜像后，0.5 为正中，供体感雷达绘制） */
  mirroredCenterX: number
  /** 实时全身骨骼重定向数据 */
  livePose: LiveBodyPose | null
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
  /** 水平散射微偏移（px） */
  driftX?: number
  kind?: 'normal' | 'crit' | 'guard' | 'dodge' | 'clash'
}

export type BattleRank = 'S' | 'A' | 'B' | 'C'

export interface BattleHudState {
  phase: GamePhase
  gameMode: GameMode
  battleStage: BattleStage
  controlMode: ControlMode
  loadingProgress: number
  calibrationProgress: number
  distanceHint: DistanceHint
  activeGestureCue: GestureActiveCue
  heroId: HeroId
  /** 当前形态（如 multi/power/sky 或 flash/strong/miracle；无形态英雄为 'base'） */
  heroForm: string
  hasForms: boolean
  waveIndex: number
  totalWaves: number
  activeTheme: ConcreteSceneTheme
  monsterId: string
  monsterState: MonsterState
  monsterHp: number
  monsterMaxHp: number
  monsterSpecialHintKey: string | null
  heroHp: number
  heroMaxHp: number
  guardStamina: number
  energy: number
  score: number
  punchChain: number
  combo: number
  maxCombo: number
  perfectGuards: number
  perfectDodges: number
  defeatedCount: number
  warningTextKey: string | null
  warningUrgency: number
  chargeKind: 'beam' | 'disc' | 'guard' | 'type' | 'spread' | 'transform' | null
  chargeProgress: number
  discCooldownRatio: number
  beamCooldownRatio: number
  beamClashActive: boolean
  beamClashProgress: number
  grappleActive: boolean
  grappleProgress: number
  transformProgress: number
  finisherReady: boolean
  finisherPhase: 'none' | 'spread' | 'beam'
  finisherProgress: number
  actionGuide: ActionGuideKind | null
  activeSkillBannerKey: string | null
  impactFlashKind: 'none' | 'heavy' | 'parry' | 'dodge' | 'hurt'
  impactFlashSeq: number
  tracking: boolean
  bodyCoverage: 'none' | 'upper' | 'full'
  mirroredCenterX: number
  poseHintKey: string
  timerDanger: boolean
  battleRank: BattleRank
  badges: string[]
}
