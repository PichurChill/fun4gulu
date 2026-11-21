export type HeroId = 'tiga' | 'zero'

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
  /** 彩色计时器 / 双眼等发光材质名匹配器（材质名或网格名包含即命中） */
  timerMaterialNames: string[]
  eyeMaterialNames: string[]
  /** 平稳期计时器材质自发光强度（单贴图材质模型设 0 避免整体泛色） */
  timerIdleIntensity: number
  /** 招式特效配色 */
  accentColor: number
  beamColor: number
  beamSuperColor: number
  discColor: number
  burstColor: number
  /** HUD 彩色计时器主题色（CSS） */
  timerTheme: 'tiga' | 'zero'
  /** 招式播报文案后缀（i18n banner key 拼接用） */
  bannerKey: string
}

export const HERO_PROFILES: Record<HeroId, HeroProfile> = {
  tiga: {
    id: 'tiga',
    modelUrl: '/models/ultraman/tiga.glb',
    bones: {
      hip: 'hip',
      spineLower: 'spineLower',
      spineUpper: 'spineUpper',
      spineChest: 'spineChest',
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
        thumb: ['Thumb1_L', 'Thumb2_L'],
      },
      fingersR: {
        index: ['Index1_R', 'Index2_R', 'Index3_R'],
        mid: ['Mid1_R', 'Mid2_R', 'Mid3_R'],
        ring: ['Ring1_R', 'Ring2_R', 'Ring3_R'],
        pinky: ['Pinky1_R', 'Pinky2_R', 'Pinky3_R'],
        thumb: ['Thumb1_R', 'Thumb2_R'],
      },
    },
    facingYaw: 0,
    timerMaterialNames: ['Tiga color timer', 'TigaEnergy'],
    eyeMaterialNames: ['Tiga eyes', 'TigaEyes'],
    timerIdleIntensity: 1.2,
    accentColor: 0x38e8ff,
    beamColor: 0x38d9ff,
    beamSuperColor: 0xfacc15,
    discColor: 0x38e8ff,
    burstColor: 0x67e8f9,
    timerTheme: 'tiga',
    bannerKey: 'Tiga',
  },
  zero: {
    id: 'zero',
    modelUrl: '/models/ultraman/zero.glb',
    bones: {
      // 注意：three.js GLTFLoader 会把骨骼名中的空白字符规范化为下划线，
      // 因此这里必须写加载后的名字（Bip001_R_Hand），而非 GLB JSON 原文中的空格版本
      hip: 'Bip001_Pelvis',
      spineLower: 'Bip001_Spine',
      spineUpper: 'Bip001_Spine1',
      spineChest: 'Bip001_Spine2',
      neckUpper: undefined,
      head: 'Bip001_Head',
      // 该导出骨架用 Twist 骨链替代主四肢骨：Clavicle → UpArmTwist → UpArmTwist1 → ForeTwist → ForeTwist1 → Hand
      upperArmL: 'Bip001_LUpArmTwist',
      lowerArmL: 'Bip001_L_ForeTwist',
      handL: 'Bip001_L_Hand',
      upperArmR: 'Bip001_RUpArmTwist',
      lowerArmR: 'Bip001_R_ForeTwist',
      handR: 'Bip001_R_Hand',
      // 腿链：ThighTwist → ThighTwist1 → CalfTwist → CalfTwist1 → Foot
      thighL: 'Bip001_LThighTwist',
      shinL: 'Bip001_LCalfTwist',
      footL: 'Bip001_L_Foot',
      thighR: 'Bip001_RThighTwist',
      shinR: 'Bip001_RCalfTwist',
      footR: 'Bip001_R_Foot',
      fingersL: {
        index: ['Bip001_L_Finger1', 'Bip001_L_Finger11', 'Bip001_L_Finger12'],
        mid: ['Bip001_L_Finger2', 'Bip001_L_Finger21', 'Bip001_L_Finger22'],
        ring: ['Bip001_L_Finger3', 'Bip001_L_Finger31', 'Bip001_L_Finger32'],
        pinky: ['Bip001_L_Finger4', 'Bip001_L_Finger41', 'Bip001_L_Finger42'],
        thumb: ['Bip001_L_Finger0', 'Bip001_L_Finger01'],
      },
      fingersR: {
        index: ['Bip001_R_Finger1', 'Bip001_R_Finger11', 'Bip001_R_Finger12'],
        mid: ['Bip001_R_Finger2', 'Bip001_R_Finger21', 'Bip001_R_Finger22'],
        ring: ['Bip001_R_Finger3', 'Bip001_R_Finger31', 'Bip001_R_Finger32'],
        pinky: ['Bip001_R_Finger4', 'Bip001_R_Finger41', 'Bip001_R_Finger42'],
        thumb: ['Bip001_R_Finger0', 'Bip001_R_Finger01'],
      },
    },
    facingYaw: 0,
    // 赛罗导出为单一贴图材质，没有独立计时器/眼睛材质：命中时整体泛光脉冲
    timerMaterialNames: [],
    eyeMaterialNames: [],
    timerIdleIntensity: 0,
    accentColor: 0x7df9ff,
    beamColor: 0x9be7ff,
    beamSuperColor: 0xffe066,
    discColor: 0x86efac,
    burstColor: 0x7df9ff,
    timerTheme: 'zero',
    bannerKey: 'Zero',
  },
}

export const HERO_IDS: HeroId[] = ['tiga', 'zero']
