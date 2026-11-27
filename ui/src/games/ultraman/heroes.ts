export type HeroId = 'tiga' | 'zero' | 'dyna' | 'zeta'

/** 形态 ID：迪迦三形态（复合/强力/空中）与戴拿三形态（闪亮/强壮/奇迹） */
export type HeroFormId = 'multi' | 'power' | 'sky' | 'flash' | 'strong' | 'miracle'

/** 战衣贴图色相重映射模式 */
export type SuitRemapMode = 'original' | 'all-red' | 'all-violet' | 'all-cobalt'

/**
 * 英雄形态档案：均衡 / 重击高伤 / 神速高能
 */
export interface HeroFormSpec {
  id: HeroFormId
  /** 形态播报 banner key 后缀 */
  bannerKey: string
  /** 战衣主贴图重映射策略（不破坏银色装甲与金色胸甲） */
  suitRemap: SuitRemapMode
  /** 银色护甲微色调乘子（基于原始银色基准微调冷暖，[1,1,1] 为原始钛银） */
  silverScale: [number, number, number]
  /** 伤害倍率 */
  damageMul: number
  /** 横向移动速度倍率 */
  moveMul: number
  /** 能量获取倍率 */
  energyGainMul: number
  /** 光轮技能冷却倍率 */
  discCooldownMul: number
  /** 形态主题配色（蓄力光球 / 光线 / 光轮 / 粒子） */
  accentColor: number
  beamColor: number
  beamSuperColor: number
  discColor: number
  burstColor: number
}

/** 手指骨链（从指根到指尖，2~3 节） */
export type FingerChain = readonly string[]

export interface HeroFingerRig {
  index: FingerChain
  mid: FingerChain
  ring: FingerChain
  pinky: FingerChain
  thumb: FingerChain
}

/**
 * 逻辑骨 -> 实际骨骼名映射（可缺省，缺省时该逻辑驱动自动跳过）
 */
export interface HeroBoneMap {
  hip?: string
  spineLower?: string
  spineUpper?: string
  spineChest?: string
  collarL?: string
  collarR?: string
  neckLower?: string
  neckUpper?: string
  head?: string
  upperArmL: string
  lowerArmL: string
  handL: string
  upperArmR: string
  lowerArmR: string
  handR: string
  thighL: string
  shinL: string
  footL: string
  thighR: string
  shinR: string
  footR: string
  fingersL: HeroFingerRig
  fingersR: HeroFingerRig
}

export interface HeroProfile {
  id: HeroId
  modelUrl: string
  bones: HeroBoneMap
  /** 模型静息站姿面朝方向与 +Z 的偏差修正（弧度，绕 Y 轴） */
  facingYaw: number
  /** 彩色计时器 / 双眼等发光材质名匹配器 */
  timerMaterialNames: string[]
  eyeMaterialNames: string[]
  /** 平稳期计时器材质自发光强度（单贴图材质模型设 0 避免整体泛色） */
  timerIdleIntensity: number
  /** 英雄固有被动增益 */
  baseDamageMul: number
  baseMoveMul: number
  baseEnergyGainMul: number
  /** 招式特效配色 */
  accentColor: number
  beamColor: number
  beamSuperColor: number
  discColor: number
  burstColor: number
  /** HUD 主题色（CSS 十六进制） */
  uiHex: string
  /** HUD 彩色计时器主题标识 */
  timerTheme: HeroId
  /** 招式播报文案后缀（i18n banner key 拼接用） */
  bannerKey: string
  /** 形态系统（迪迦、戴拿三形态；缺失表示该英雄为固定觉醒态） */
  forms?: HeroFormSpec[]
  /** 形态染色用的身体材质名匹配器 */
  formBodyMaterials?: { silver: string[]; suit: string[] }
  /** 加载后重建的骨骼父子关系（[父, 子]） */
  relinkBones?: [string, string][]
}

const ultraBones: HeroBoneMap = {
  hip: 'hip',
  spineLower: 'spineLower',
  spineUpper: 'spineUpper',
  spineChest: 'spineChest',
  collarL: 'Collar_L',
  collarR: 'Collar_R',
  neckLower: 'neckLower',
  neckUpper: 'neckUpper',
  head: 'head',
  upperArmL: 'UpperArm_L',
  lowerArmL: 'LowerArm_L',
  handL: 'Hand_L',
  upperArmR: 'UpperArm_R',
  lowerArmR: 'LowerArm_R',
  handR: 'Hand_R',
  thighL: 'Thigh_L',
  shinL: 'Shin_L',
  footL: 'Foot_L',
  thighR: 'Thigh_R',
  shinR: 'Shin_R',
  footR: 'Foot_R',
  fingersL: {
    index: ['Index1_L', 'Index2_L', 'Index3_L'],
    mid: ['Mid1_L', 'Mid2_L', 'Mid3_L'],
    ring: ['Ring1_L', 'Ring2_L', 'Ring3_L'],
    pinky: ['Pinky1_L', 'Pinky2_L', 'Pinky3_L'],
    thumb: ['Thumb1_L', 'Thumb2_L', 'Thumb3_L'],
  },
  fingersR: {
    index: ['Index1_R', 'Index2_R', 'Index3_R'],
    mid: ['Mid1_R', 'Mid2_R', 'Mid3_R'],
    ring: ['Ring1_R', 'Ring2_R', 'Ring3_R'],
    pinky: ['Pinky1_R', 'Pinky2_R', 'Pinky3_R'],
    thumb: ['Thumb1_R', 'Thumb2_R', 'Thumb3_R'],
  },
}

export const HERO_PROFILES: Record<HeroId, HeroProfile> = {
  tiga: {
    id: 'tiga',
    modelUrl: '/models/ultraman/tiga.glb',
    bones: ultraBones,
    facingYaw: 0,
    timerMaterialNames: ['Tiga color timer', 'TigaEnergy'],
    eyeMaterialNames: ['Tiga eyes', 'TigaEyes'],
    timerIdleIntensity: 1.5,
    baseDamageMul: 1.0,
    baseMoveMul: 1.0,
    baseEnergyGainMul: 1.0,
    accentColor: 0x38e8ff,
    beamColor: 0x38d9ff,
    beamSuperColor: 0xfacc15,
    discColor: 0x38e8ff,
    burstColor: 0x67e8f9,
    uiHex: '#38e8ff',
    timerTheme: 'tiga',
    bannerKey: 'Tiga',
    formBodyMaterials: { silver: ['Tiga body silver'], suit: ['Tiga body Multi-Type'] },
    forms: [
      {
        id: 'multi',
        bannerKey: 'Multi',
        suitRemap: 'original',
        silverScale: [1, 1, 1],
        damageMul: 1.0,
        moveMul: 1.0,
        energyGainMul: 1.0,
        discCooldownMul: 1.0,
        accentColor: 0x38e8ff,
        beamColor: 0x38d9ff,
        beamSuperColor: 0xfacc15,
        discColor: 0x38e8ff,
        burstColor: 0x67e8f9,
      },
      {
        id: 'power',
        bannerKey: 'Power',
        suitRemap: 'all-red',
        silverScale: [1.04, 0.98, 0.96],
        damageMul: 1.45,
        moveMul: 0.85,
        energyGainMul: 0.95,
        discCooldownMul: 1.1,
        accentColor: 0xff5a3c,
        beamColor: 0xff5a3c,
        beamSuperColor: 0xffb020,
        discColor: 0xff8a5c,
        burstColor: 0xff7a5c,
      },
      {
        id: 'sky',
        bannerKey: 'Sky',
        suitRemap: 'all-violet',
        silverScale: [0.96, 1.0, 1.08],
        damageMul: 0.85,
        moveMul: 1.38,
        energyGainMul: 1.28,
        discCooldownMul: 0.65,
        accentColor: 0xb388ff,
        beamColor: 0xb388ff,
        beamSuperColor: 0xe0c3ff,
        discColor: 0xc9a7ff,
        burstColor: 0xc9a7ff,
      },
    ],
  },
  zero: {
    id: 'zero',
    modelUrl: '/models/ultraman/zero.glb',
    bones: {
      hip: 'Bip001_Pelvis',
      spineLower: 'Bip001_Spine',
      spineUpper: undefined,
      spineChest: 'Bip001_Spine1',
      collarL: 'Bip001_L_Clavicle',
      collarR: 'Bip001_R_Clavicle',
      neckUpper: 'Bip001_Neck',
      head: 'Bip001_Head',
      upperArmL: 'Bip001_L_UpperArm',
      lowerArmL: 'Bip001_L_Forearm',
      handL: 'Bip001_L_Hand',
      upperArmR: 'Bip001_R_UpperArm',
      lowerArmR: 'Bip001_R_Forearm',
      handR: 'Bip001_R_Hand',
      thighL: 'Bip001_L_Thigh',
      shinL: 'Bip001_L_Calf',
      footL: 'Bip001_L_Foot',
      thighR: 'Bip001_R_Thigh',
      shinR: 'Bip001_R_Calf',
      footR: 'Bip001_R_Foot',
      fingersL: {
        index: ['Bip001_L_Finger1', 'Bip001_L_Finger11'],
        mid: ['Bip001_L_Finger2', 'Bip001_L_Finger21'],
        ring: ['Bip001_L_Finger3', 'Bip001_L_Finger31'],
        pinky: ['Bip001_L_Finger4', 'Bip001_L_Finger41'],
        thumb: ['Bip001_L_Finger0', 'Bip001_L_Finger01'],
      },
      fingersR: {
        index: ['Bip001_R_Finger1', 'Bip001_R_Finger11'],
        mid: ['Bip001_R_Finger2', 'Bip001_R_Finger21'],
        ring: ['Bip001_R_Finger3', 'Bip001_R_Finger31'],
        pinky: ['Bip001_R_Finger4', 'Bip001_R_Finger41'],
        thumb: ['Bip001_R_Finger0', 'Bip001_R_Finger01'],
      },
    },
    facingYaw: 0,
    timerMaterialNames: [],
    eyeMaterialNames: [],
    timerIdleIntensity: 0,
    baseDamageMul: 1.15,
    baseMoveMul: 1.12,
    baseEnergyGainMul: 1.15,
    accentColor: 0x7df9ff,
    beamColor: 0x5eead4,
    beamSuperColor: 0xffe066,
    discColor: 0x4ade80,
    burstColor: 0x7df9ff,
    uiHex: '#5eead4',
    timerTheme: 'zero',
    bannerKey: 'Zero',
  },
  dyna: {
    id: 'dyna',
    modelUrl: '/models/ultraman/dyna.glb',
    bones: {
      hip: 'Bip002_Pelvis_04',
      spineLower: 'Bip002_Spine_05',
      spineUpper: undefined,
      spineChest: 'Bip002_Spine1_014',
      collarL: 'Bip002_L_Clavicle_00',
      collarR: 'Bip002_R_Clavicle_030',
      neckUpper: 'Bip002_Neck_015',
      head: 'Bip002_Head_016',
      upperArmL: 'Bip002_L_UpperArm_017',
      lowerArmL: 'Bip002_L_Forearm_018',
      handL: 'Bip002_L_Hand_019',
      upperArmR: 'Bip002_R_UpperArm_031',
      lowerArmR: 'Bip002_R_Forearm_032',
      handR: 'Bip002_R_Hand_033',
      thighL: 'Bip002_L_Thigh_06',
      shinL: 'Bip002_L_Calf_07',
      footL: 'Bip002_L_Foot_08',
      thighR: 'Bip002_R_Thigh_010',
      shinR: 'Bip002_R_Calf_011',
      footR: 'Bip002_R_Foot_012',
      fingersL: {
        index: ['Bip002_L_Finger1_022', 'Bip002_L_Finger11_023'],
        mid: ['Bip002_L_Finger2_024', 'Bip002_L_Finger21_025'],
        ring: ['Bip002_L_Finger3_026', 'Bip002_L_Finger31_027'],
        pinky: ['Bip002_L_Finger4_028', 'Bip002_L_Finger41_029'],
        thumb: ['Bip002_L_Finger0_020', 'Bip002_L_Finger01_021'],
      },
      fingersR: {
        index: ['Bip002_R_Finger1_036', 'Bip002_R_Finger11_037'],
        mid: ['Bip002_R_Finger2_038', 'Bip002_R_Finger21_039'],
        ring: ['Bip002_R_Finger3_040', 'Bip002_R_Finger31_041'],
        pinky: ['Bip002_R_Finger4_042', 'Bip002_R_Finger41_043'],
        thumb: ['Bip002_R_Finger0_034', 'Bip002_R_Finger01_035'],
      },
    },
    facingYaw: 0,
    timerMaterialNames: [],
    eyeMaterialNames: [],
    timerIdleIntensity: 0,
    baseDamageMul: 1.05,
    baseMoveMul: 1.0,
    baseEnergyGainMul: 1.0,
    timerTheme: 'dyna',
    bannerKey: 'Dyna',
    accentColor: 0xffbd49,
    beamColor: 0x60a5fa,
    beamSuperColor: 0xfff3a8,
    discColor: 0x77b9ff,
    burstColor: 0xffd776,
    uiHex: '#ffbd49',
    formBodyMaterials: { silver: [], suit: ['dyna_suit_mat'] },
    forms: [
      {
        id: 'flash',
        bannerKey: 'Flash',
        suitRemap: 'original',
        silverScale: [1, 1, 1],
        damageMul: 1.0,
        moveMul: 1.0,
        energyGainMul: 1.0,
        discCooldownMul: 1.0,
        accentColor: 0xffbd49,
        beamColor: 0x60a5fa,
        beamSuperColor: 0xfff3a8,
        discColor: 0x77b9ff,
        burstColor: 0xffd776,
      },
      {
        id: 'strong',
        bannerKey: 'Strong',
        suitRemap: 'all-red',
        silverScale: [1.05, 0.97, 0.95],
        damageMul: 1.48,
        moveMul: 0.86,
        energyGainMul: 0.95,
        discCooldownMul: 1.15,
        accentColor: 0xff4d38,
        beamColor: 0xff6b3d,
        beamSuperColor: 0xffd166,
        discColor: 0xff8552,
        burstColor: 0xff6b4a,
      },
      {
        id: 'miracle',
        bannerKey: 'Miracle',
        suitRemap: 'all-cobalt',
        silverScale: [0.95, 1.01, 1.08],
        damageMul: 0.88,
        moveMul: 1.38,
        energyGainMul: 1.35,
        discCooldownMul: 0.6,
        accentColor: 0x38bdf8,
        beamColor: 0x38bdf8,
        beamSuperColor: 0xa5f3fc,
        discColor: 0x67e8f9,
        burstColor: 0x7dd3fc,
      },
    ],
  },
  zeta: {
    id: 'zeta',
    modelUrl: '/models/ultraman/zeta.glb',
    bones: {
      hip: 'Bip001_Pelvis',
      spineLower: 'Bip001_Spine',
      spineUpper: undefined,
      spineChest: 'Bip001_Spine1',
      collarL: 'Bip001_L_Clavicle',
      collarR: 'Bip001_R_Clavicle',
      neckUpper: 'Bip001_Neck',
      head: 'Bip001_Head',
      upperArmL: 'Bip001_L_UpperArm',
      lowerArmL: 'Bip001_L_Forearm',
      handL: 'Bip001_L_Hand',
      upperArmR: 'Bip001_R_UpperArm',
      lowerArmR: 'Bip001_R_Forearm',
      handR: 'Bip001_R_Hand',
      thighL: 'Bip001_L_Thigh',
      shinL: 'Bip001_L_Calf',
      footL: 'Bip001_L_Foot',
      thighR: 'Bip001_R_Thigh',
      shinR: 'Bip001_R_Calf',
      footR: 'Bip001_R_Foot',
      fingersL: {
        index: ['Bip001_L_Finger1', 'Bip001_L_Finger11'],
        mid: ['Bip001_L_Finger2', 'Bip001_L_Finger21'],
        ring: ['Bip001_L_Finger3', 'Bip001_L_Finger31'],
        pinky: ['Bip001_L_Finger4', 'Bip001_L_Finger41'],
        thumb: ['Bip001_L_Finger0', 'Bip001_L_Finger01'],
      },
      fingersR: {
        index: ['Bip001_R_Finger1', 'Bip001_R_Finger11'],
        mid: ['Bip001_R_Finger2', 'Bip001_R_Finger21'],
        ring: ['Bip001_R_Finger3', 'Bip001_R_Finger31'],
        pinky: ['Bip001_R_Finger4', 'Bip001_R_Finger41'],
        thumb: ['Bip001_R_Finger0', 'Bip001_R_Finger01'],
      },
    },
    facingYaw: 0,
    timerMaterialNames: [],
    eyeMaterialNames: [],
    timerIdleIntensity: 0,
    baseDamageMul: 1.08,
    baseMoveMul: 1.1,
    baseEnergyGainMul: 1.22,
    timerTheme: 'zeta',
    bannerKey: 'Zeta',
    accentColor: 0x57b8ff,
    beamColor: 0x38e8ff,
    beamSuperColor: 0xc084fc,
    discColor: 0x60a5fa,
    burstColor: 0x74dfff,
    uiHex: '#60a5fa',
  },
}

export const HERO_IDS: HeroId[] = ['tiga', 'zero', 'dyna', 'zeta']
