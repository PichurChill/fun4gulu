import * as THREE from 'three'
import { releaseModel } from './releaseModel'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { FingerChain, HeroFormSpec, HeroProfile, SuitRemapMode } from './heroes'
import type { HeroAction, LiveBodyPose, Vec3Like } from './types'

const tmpV1 = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpV4 = new THREE.Vector3()
const tmpV5 = new THREE.Vector3()
const tmpQ1 = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpQ3 = new THREE.Quaternion()

function lerpArenaVec(
  target: THREE.Vector3,
  src: Vec3Like,
  alpha: number,
  sideSign: 1 | -1,
) {
  tmpV1.set(src.x * sideSign, src.y, src.z * sideSign)
  if (tmpV1.lengthSq() < 1e-6) return
  tmpV1.normalize()
  target.lerp(tmpV1, alpha)
  if (target.lengthSq() > 1e-6) target.normalize()
}

/**
 * 离屏像素级战衣色相重映射（仅在加载英雄模型时生成一次并缓存）
 */
function buildRemappedSuitTexture(baseTex: THREE.Texture, mode: SuitRemapMode): THREE.Texture {
  if (mode === 'original') return baseTex
  const img = baseTex.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement) | undefined
  if (!img || !('width' in img) || img.width <= 0 || img.height <= 0) return baseTex

  const w = img.width
  const h = img.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return baseTex

  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const d = imageData.data

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    const maxC = Math.max(r, g, b)
    const minC = Math.min(r, g, b)
    const sat = maxC - minC
    if (sat < 20) continue

    if (mode === 'all-red') {
      // 将深蓝/蓝紫战衣重映射为强壮/强力红，排除高光青白胸灯（g < b * 0.78）
      if (b > g + 12 && b > r * 0.52 && g < b * 0.78) {
        const lum = Math.max(r, b)
        d[i] = Math.min(255, Math.round(lum * 1.18 + 14))
        d[i + 1] = Math.round(Math.min(g, lum * 0.28) * 0.55)
        d[i + 2] = Math.round(Math.min(r, g) * 0.35)
      } else if (r > b + 18 && r > g + 18 && g < r * 0.54) {
        d[i] = Math.min(255, Math.round(r * 1.08 + 6))
        d[i + 1] = Math.round(g * 0.78)
        d[i + 2] = Math.round(b * 0.72)
      }
    } else if (mode === 'all-violet') {
      // 排除金色胸甲与黄色复眼（g < r * 0.54），仅重映射红色战衣
      if (r > b + 14 && r > g + 14 && g < r * 0.54) {
        d[i] = Math.round(r * 0.46 + b * 0.24)
        d[i + 1] = Math.round(g * 0.75 + r * 0.14)
        d[i + 2] = Math.min(255, Math.round(r * 1.04 + 18))
      } else if (b > g + 10 && g < b * 0.8) {
        d[i] = Math.round(r * 0.85)
        d[i + 2] = Math.min(255, Math.round(b * 1.1 + 10))
      }
    } else if (mode === 'all-cobalt') {
      // 排除金色胸甲与黄色复眼（g < r * 0.54），仅将红色战衣重映射为奇迹钴蓝
      if (r > b + 14 && r > g + 14 && g < r * 0.54) {
        d[i] = Math.round(r * 0.16)
        d[i + 1] = Math.round(r * 0.45 + g * 0.35)
        d[i + 2] = Math.min(255, Math.round(r * 1.08 + 20))
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY = baseTex.flipY
  tex.colorSpace = baseTex.colorSpace
  tex.wrapS = baseTex.wrapS
  tex.wrapT = baseTex.wrapT
  tex.anisotropy = baseTex.anisotropy
  tex.needsUpdate = true
  return tex
}

/**
 * 从 tiga.glb 原装 TigaEyes 网格提取完整单侧复眼簇，归位并镜像重建对称无蒙皮双复眼几何体
 */
function buildSymmetricTigaEyesGeometry(srcGeo: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const posAttr = srcGeo.getAttribute('position')
  if (!posAttr || posAttr.count < 12) return null

  const indexAttr = srcGeo.getIndex()
  const triIndices: number[] = []
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i++) triIndices.push(indexAttr.getX(i))
  } else {
    for (let i = 0; i < posAttr.count; i++) triIndices.push(i)
  }

  // 对齐至迪迦银色面罩真实眼窝凹槽（y ∈ [2.97, 3.06], |x| ∈ [0.019, 0.131]）
  const shiftX = -0.0665
  const shiftY = 0.168
  const shiftZ = 0.008

  const outPositions: number[] = []
  const outIndices: number[] = []
  const rightMap = new Map<number, number>()
  const leftMap = new Map<number, number>()

  const getRightVert = (oldIdx: number): number => {
    const hit = rightMap.get(oldIdx)
    if (hit !== undefined) return hit
    const nextIdx = outPositions.length / 3
    outPositions.push(
      posAttr.getX(oldIdx) + shiftX,
      posAttr.getY(oldIdx) + shiftY,
      posAttr.getZ(oldIdx) + shiftZ,
    )
    rightMap.set(oldIdx, nextIdx)
    return nextIdx
  }

  const getLeftVert = (oldIdx: number): number => {
    const hit = leftMap.get(oldIdx)
    if (hit !== undefined) return hit
    const nextIdx = outPositions.length / 3
    outPositions.push(
      -(posAttr.getX(oldIdx) + shiftX),
      posAttr.getY(oldIdx) + shiftY,
      posAttr.getZ(oldIdx) + shiftZ,
    )
    leftMap.set(oldIdx, nextIdx)
    return nextIdx
  }

  for (let t = 0; t + 2 < triIndices.length; t += 3) {
    const ia = triIndices[t]!
    const ib = triIndices[t + 1]!
    const ic = triIndices[t + 2]!
    if (posAttr.getX(ia) >= 0.065 && posAttr.getX(ib) >= 0.065 && posAttr.getX(ic) >= 0.065) {
      outIndices.push(getRightVert(ia), getRightVert(ib), getRightVert(ic))
      // 镜像侧翻转绕序保证法线朝外
      outIndices.push(getLeftVert(ia), getLeftVert(ic), getLeftVert(ib))
    }
  }

  if (outIndices.length === 0) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3))
  geo.setIndex(outIndices)
  geo.computeVertexNormals()
  return geo
}

export interface HeroControllerOptions {
  /** 阵营朝向：1 = 南端驻守 +baseZ 面朝 -Z；-1 = 北端驻守 -baseZ 面朝 +Z（双人对战 P2） */
  sideSign?: 1 | -1
  /** 站位距中心基准距离（正数，实际世界 Z = sideSign * baseZ） */
  baseZ?: number
}

/**
 * 奥特曼第三人称全身骨骼与特摄近战突进控制器（支持单人闯关与双人同场面对面对决）
 */
export class HeroController {
  public readonly root = new THREE.Group()
  public readonly sideSign: 1 | -1
  public readonly baseZ: number
  private readonly baseYaw: number

  private model: THREE.Object3D | null = null
  private modelBaseY = 0
  private profile: HeroProfile | null = null
  private loadGen = 0
  private bones = new Map<string, THREE.Bone>()
  private logical = new Map<string, THREE.Bone>()
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private restPositions = new Map<THREE.Bone, THREE.Vector3>()
  private boneTips = new Map<THREE.Bone, THREE.Vector3>()
  /** 骨骼局部参考法线（腿骨为膝盖正前法线，前臂为掌心内向法线，用于消除绕骨长轴拧麻花） */
  private boneRefNormals = new Map<THREE.Bone, THREE.Vector3>()
  /** 每节指骨在自身并拢手刀基准态下的局部向掌心弯曲铰链轴 */
  private fingerCurlAxes = new Map<THREE.Bone, THREE.Vector3>()
  /** 五指并拢成特摄标准手刀的局部基准四元数（消除 T-Pose 原厂扇形分叉鸭蹼手） */
  private fingerBladeQuats = new Map<THREE.Bone, THREE.Quaternion>()
  /** 自适应握拳弯度乘子（补偿无静息预弯模型使握拳饱满紧实） */
  private fingerCurlScales: Record<'L' | 'R', number> = { L: 1, R: 1 }
  /** 双脚在静息站姿下相对于角色 root 的朝向四元数（用于站立马步保持脚底水平贴地） */
  private footRestRelQuats = new Map<'L' | 'R', THREE.Quaternion>()

  private timerMaterials: THREE.MeshStandardMaterial[] = []
  private eyeMaterials: THREE.MeshStandardMaterial[] = []
  private customChestDomeMat: THREE.MeshStandardMaterial | null = null
  private customAttachments: THREE.Object3D[] = []
  private customGeometries: THREE.BufferGeometry[] = []
  private customMaterials: THREE.Material[] = []

  private formSilverEntries: { mat: THREE.MeshStandardMaterial; baseColor: THREE.Color }[] = []
  private formSuitEntries: {
    mat: THREE.MeshStandardMaterial
    baseColor: THREE.Color
    originalMap: THREE.Texture | null
    remappedMaps: Map<SuitRemapMode, THREE.Texture>
  }[] = []
  private derivedTextures: THREE.Texture[] = []
  private currentForm: HeroFormSpec | null = null
  private restAnkleY = 0.85

  public currentX = 0
  private targetX = 0
  private action: HeroAction = 'idle'
  private actionTime = 0
  private actionDuration = 0.35
  private beamChargeVisual = 0
  private discChargeVisual = 0
  private discChargeSide: 'left' | 'right' = 'right'
  private beamArmSide: 'left' | 'right' = 'right'
  private isGuarding = false
  private victoryAscent = 0

  private combatLungeZ = 0
  private combatVaultY = 0

  private livePose: LiveBodyPose | null = null
  private lastLivePoseTime = -Infinity
  private smTorsoPitch = 0
  private smTorsoRoll = 0
  private smTorsoYaw = 0
  private smHeadYaw = 0
  private smHeadPitch = 0
  private smHeadRoll = 0
  private smJumpHeight = 0
  private smCrouchDepth = 0
  private smUpperL = new THREE.Vector3()
  private smLowerL = new THREE.Vector3()
  private smHandL = new THREE.Vector3()
  private smUpperR = new THREE.Vector3()
  private smLowerR = new THREE.Vector3()
  private smHandR = new THREE.Vector3()
  private smThighL = new THREE.Vector3()
  private smShinL = new THREE.Vector3()
  private smThighR = new THREE.Vector3()
  private smShinR = new THREE.Vector3()

  constructor(scene: THREE.Scene, opts?: HeroControllerOptions) {
    this.sideSign = opts?.sideSign ?? 1
    this.baseZ = opts?.baseZ ?? 13.2
    this.baseYaw = this.sideSign === 1 ? Math.PI : 0

    this.root.name = this.sideSign === 1 ? 'UltraHeroRootP1' : 'UltraHeroRootP2'
    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw, 0)
    this.resetSmoothLimbs()
    scene.add(this.root)
  }

  private resetSmoothLimbs() {
    const s = this.sideSign
    this.smUpperL.set(-0.45 * s, -0.35, -0.78 * s).normalize()
    this.smLowerL.set(0.22 * s, 0.42, -0.88 * s).normalize()
    this.smHandL.set(0.22 * s, 0.42, -0.88 * s).normalize()
    this.smUpperR.set(0.55 * s, -0.52, -0.62 * s).normalize()
    this.smLowerR.set(-0.18 * s, 0.24, -0.95 * s).normalize()
    this.smHandR.set(-0.18 * s, 0.24, -0.95 * s).normalize()
    this.smThighL.set(-0.12 * s, -0.97, -0.18 * s).normalize()
    this.smShinL.set(-0.1 * s, -0.98, 0.14 * s).normalize()
    this.smThighR.set(0.14 * s, -0.97, -0.05 * s).normalize()
    this.smShinR.set(0.12 * s, -0.98, 0.18 * s).normalize()
  }

  /** 当前英雄世界 Z 坐标 */
  public get worldZ(): number {
    return this.root.position.z
  }

  /** 当前英雄站位基准世界 Z 坐标 */
  public get homeWorldZ(): number {
    return this.sideSign * this.baseZ
  }

  /** 获取当前英雄胸口受击目标中心（供双人对战对手锁敌瞄准） */
  public getTargetCenter(): THREE.Vector3 {
    return new THREE.Vector3(
      this.currentX,
      this.root.position.y + 8.8,
      this.root.position.z - 0.6 * this.sideSign,
    )
  }

  public async load(loader: GLTFLoader, profile: HeroProfile): Promise<void> {
    const gen = ++this.loadGen
    if (this.profile?.id === profile.id && this.model) return
    const gltf = await loader.loadAsync(profile.modelUrl)
    if (gen !== this.loadGen) {
      releaseModel(gltf.scene)
      return
    }
    this.unloadModel()
    this.profile = profile
    const model = gltf.scene
    this.model = model

    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw + profile.facingYaw, 0)

    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const height = Math.max(0.001, box.max.y - box.min.y)
    const center = box.getCenter(new THREE.Vector3())
    const scale = 13.5 / height
    model.scale.multiplyScalar(scale)
    this.modelBaseY = -box.min.y * scale
    model.position.set(-center.x * scale, this.modelBaseY, -center.z * scale)
    this.root.add(model)
    this.root.updateMatrixWorld(true)

    this.timerMaterials = []
    this.eyeMaterials = []
    this.customChestDomeMat = null
    this.formSilverEntries = []
    this.formSuitEntries = []
    this.derivedTextures = []
    this.currentForm = null

    const staticAttachments: THREE.Mesh[] = []
    let rawTigaEyesGeo: THREE.BufferGeometry | null = null

    const neededRemaps = new Set<SuitRemapMode>()
    if (profile.forms) {
      for (const f of profile.forms) {
        if (f.suitRemap !== 'original') neededRemaps.add(f.suitRemap)
      }
    }

    model.traverse((node) => {
      if ((node as THREE.Bone).isBone) {
        const bone = node as THREE.Bone
        this.bones.set(bone.name, bone)
        this.restQuats.set(bone, bone.quaternion.clone())
        this.restPositions.set(bone, bone.position.clone())
      }
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        // 迪迦原装 TigaEyes / TigaEnergy / TigaEnergyContainer 在导出时未归中且混入骨盆权重，提取几何后隐藏原网格
        if (
          profile.id === 'tiga' &&
          (mesh.name.includes('TigaEyes') ||
            mesh.name.includes('TigaEnergy') ||
            mesh.name.includes('TigaEnergyContainer'))
        ) {
          if (mesh.name.includes('TigaEyes') && !rawTigaEyesGeo) {
            rawTigaEyesGeo = mesh.geometry
          }
          mesh.visible = false
          return
        }
        if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          staticAttachments.push(mesh)
        }
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial) {
            if (m.emissiveMap) {
              m.emissive.setHex(0xffffff)
              m.emissiveIntensity = 1.65
            }
            const matches = (names: string[]) =>
              names.some((n) => m.name.includes(n) || mesh.name.includes(n))
            if (profile.formBodyMaterials && matches(profile.formBodyMaterials.silver)) {
              m.roughness = 0.36
              m.metalness = 0.56
              this.formSilverEntries.push({ mat: m, baseColor: m.color.clone() })
            } else if (profile.formBodyMaterials && matches(profile.formBodyMaterials.suit)) {
              m.roughness = 0.54
              m.metalness = 0.14
              const remappedMaps = new Map<SuitRemapMode, THREE.Texture>()
              if (m.map) {
                remappedMaps.set('original', m.map)
                for (const mode of neededRemaps) {
                  const derived = buildRemappedSuitTexture(m.map, mode)
                  remappedMaps.set(mode, derived)
                  if (derived !== m.map) this.derivedTextures.push(derived)
                }
              }
              this.formSuitEntries.push({
                mat: m,
                baseColor: m.color.clone(),
                originalMap: m.map,
                remappedMaps,
              })
            } else if (profile.timerMaterialNames.length > 0 && matches(profile.timerMaterialNames)) {
              if (!mesh.name.includes('Container') && !mesh.name.includes('rim')) {
                this.timerMaterials.push(m)
                m.emissive = new THREE.Color(profile.accentColor)
                m.emissiveIntensity = profile.timerIdleIntensity
                m.roughness = 0.2
              }
            } else if (profile.eyeMaterialNames.length > 0 && matches(profile.eyeMaterialNames)) {
              this.eyeMaterials.push(m)
              m.emissive = new THREE.Color(0xfff6cc)
              m.emissiveIntensity = 2.0
              m.roughness = 0.18
            } else {
              const isGold = /gold|amber/i.test(m.name)
              m.roughness = isGold ? 0.32 : 0.52
              m.metalness = isGold ? 0.68 : 0.18
            }
          }
        }
      }
    })

    if (profile.relinkBones) {
      for (const [parentName, childName] of profile.relinkBones) {
        const parent = this.bones.get(parentName)
        const child = this.bones.get(childName)
        if (!parent || !child || child.parent === parent) continue
        parent.attach(child)
        this.restQuats.set(child, child.quaternion.clone())
        this.restPositions.set(child, child.position.clone())
      }
      this.root.updateMatrixWorld(true)
    }

    if (staticAttachments.length > 0 && this.bones.size > 0) {
      this.root.updateMatrixWorld(true)
      const headBone = this.bones.get(profile.bones.head ?? '')
      const armCandidates = [
        this.bones.get(profile.bones.lowerArmL),
        this.bones.get(profile.bones.handL),
        this.bones.get(profile.bones.lowerArmR),
        this.bones.get(profile.bones.handR),
      ].filter((b): b is THREE.Bone => !!b)

      for (const part of staticAttachments) {
        const boxCenter = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3())
        if (/jiao|horn|crest|helmet|crown|lens/i.test(part.name) && headBone) {
          headBone.attach(part)
        } else if (/shouzhuo|bracelet|wrist/i.test(part.name) && armCandidates.length > 0) {
          let bestBone = armCandidates[0]!
          let minDist = Infinity
          for (const cand of armCandidates) {
            const d = cand.getWorldPosition(new THREE.Vector3()).distanceTo(boxCenter)
            if (d < minDist) {
              minDist = d
              bestBone = cand
            }
          }
          bestBone.attach(part)
        }
      }
      this.root.updateMatrixWorld(true)
    }

    this.logical.clear()
    for (const [key, actualName] of Object.entries(profile.bones)) {
      if (!actualName || key === 'fingersL' || key === 'fingersR') continue
      const bone = this.bones.get(actualName)
      if (bone) this.logical.set(key, bone)
    }

    const requiredLimbs = [
      'upperArmL', 'lowerArmL', 'handL',
      'upperArmR', 'lowerArmR', 'handR',
      'thighL', 'shinL', 'footL',
      'thighR', 'shinR', 'footR',
      'head', 'spineLower', 'spineChest',
    ] as const
    const missing = requiredLimbs.filter((key) => !this.logical.has(key))
    if (missing.length > 0) {
      throw new Error(`[HeroRig] ${profile.id} 模型缺少关键骨骼映射: ${missing.join(', ')}`)
    }
    for (const [sideName, fingers] of [
      ['fingersL', profile.bones.fingersL],
      ['fingersR', profile.bones.fingersR],
    ] as const) {
      for (const chainName of ['index', 'pinky', 'thumb'] as const) {
        if (!fingers[chainName].some((n) => this.bones.has(n))) {
          throw new Error(`[HeroRig] ${profile.id} 模型 ${sideName}.${chainName} 手指骨链全部缺失`)
        }
      }
    }

    // Fail-Fast 校验左右四肢解剖位置（当面朝 -sideSign * Z 时，左肩与左胯在阵营空间 X 必小于右肩与右胯）
    this.root.updateMatrixWorld(true)
    const armLX = this.logical.get('upperArmL')!.getWorldPosition(new THREE.Vector3()).x * this.sideSign
    const armRX = this.logical.get('upperArmR')!.getWorldPosition(new THREE.Vector3()).x * this.sideSign
    if (armLX >= armRX) {
      throw new Error(
        `[HeroRig] ${profile.id} 左右肢体骨骼映射颠倒: armLX=${armLX.toFixed(3)}, armRX=${armRX.toFixed(3)}`,
      )
    }

    // 为迪迦重建原装对称发光复眼、眉心迪迦水晶与带银环的立体彩色计时器
    if (profile.id === 'tiga') {
      this.mountTigaFeatures(model, profile, rawTigaEyesGeo)
    }

    // 计算骨骼轴向尾端：主干四肢优先指向解剖学下一级关节，彻底排除 *Twist1 等偏侧辅助骨干扰
    this.calibrateBoneTips(model, profile)

    // 标定腿部膝盖前法线、前臂掌心法线、双脚水平贴地基准与五指局部铰链弯曲轴
    this.calibrateLimbNormalsAndFingers(profile)

    const footL = this.logical.get('footL')
    const footR = this.logical.get('footR')
    if (footL && footR) {
      this.root.updateMatrixWorld(true)
      this.restAnkleY = Math.min(
        footL.getWorldPosition(new THREE.Vector3()).y,
        footR.getWorldPosition(new THREE.Vector3()).y,
      )
    }

    this.setForm(profile.forms?.[0] ?? null)
  }

  private mountTigaFeatures(
    model: THREE.Object3D,
    profile: HeroProfile,
    rawEyesGeo: THREE.BufferGeometry | null,
  ) {
    const headBone = this.logical.get('head')
    const chestBone = this.bones.get('chestUpper') ?? this.logical.get('spineChest')

    if (headBone) {
      // 1. 重建原装对称双发光复眼（直接在 model 原生网格局部空间定位后 attach 至 headBone）
      const eyesGeo = rawEyesGeo ? buildSymmetricTigaEyesGeometry(rawEyesGeo) : null
      if (eyesGeo) {
        const eyesMat = new THREE.MeshStandardMaterial({
          color: 0xfff8dc,
          emissive: new THREE.Color(0xffe58f),
          emissiveIntensity: 1.95,
          roughness: 0.14,
          metalness: 0.05,
        })
        const eyesMesh = new THREE.Mesh(eyesGeo, eyesMat)
        eyesMesh.name = 'TigaRebuiltEyes'
        eyesMesh.castShadow = false
        model.add(eyesMesh)
        this.root.updateMatrixWorld(true)
        headBone.updateWorldMatrix(true, false)
        headBone.attach(eyesMesh)

        this.customAttachments.push(eyesMesh)
        this.customGeometries.push(eyesGeo)
        this.customMaterials.push(eyesMat)
        this.eyeMaterials.push(eyesMat)
      }

      // 2. 镶嵌迪迦额头菱形发光水晶（Tiga Crystal，位于面罩眉心水晶槽 (0, 3.128, 0.222)）
      const crystalGeo = new THREE.OctahedronGeometry(0.019, 0)
      const crystalMat = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        emissive: new THREE.Color(0xe0f2fe),
        emissiveIntensity: 1.45,
        roughness: 0.12,
        metalness: 0.15,
      })
      const crystalMesh = new THREE.Mesh(crystalGeo, crystalMat)
      crystalMesh.name = 'TigaForeheadCrystal'
      crystalMesh.position.set(0, 3.128, 0.222)
      crystalMesh.scale.set(0.66, 1.82, 0.55)
      model.add(crystalMesh)
      this.root.updateMatrixWorld(true)
      headBone.updateWorldMatrix(true, false)
      headBone.attach(crystalMesh)

      this.customAttachments.push(crystalMesh)
      this.customGeometries.push(crystalGeo)
      this.customMaterials.push(crystalMat)
    }

    if (chestBone) {
      // 3. 镶嵌胸甲正中银环底座 + 冰蓝水晶彩色计时器（位于胸甲开孔中心 (0, 2.416, 0.218)）
      const timerGroup = new THREE.Group()
      timerGroup.name = 'TigaRebuiltColorTimer'
      timerGroup.position.set(0, 2.416, 0.218)

      const rimGeo = new THREE.TorusGeometry(0.05, 0.011, 12, 28)
      const rimMat = new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        roughness: 0.28,
        metalness: 0.72,
      })
      const rimMesh = new THREE.Mesh(rimGeo, rimMat)
      rimMesh.scale.set(0.94, 1.12, 0.65)
      timerGroup.add(rimMesh)

      const domeGeo = new THREE.SphereGeometry(0.046, 20, 14)
      const domeMat = new THREE.MeshStandardMaterial({
        color: 0x7dd3fc,
        emissive: new THREE.Color(profile.accentColor),
        emissiveIntensity: 1.85,
        roughness: 0.12,
        metalness: 0.08,
      })
      const domeMesh = new THREE.Mesh(domeGeo, domeMat)
      domeMesh.position.set(0, 0, 0.004)
      domeMesh.scale.set(0.92, 1.1, 0.52)
      timerGroup.add(domeMesh)

      model.add(timerGroup)
      this.root.updateMatrixWorld(true)
      chestBone.updateWorldMatrix(true, false)
      chestBone.attach(timerGroup)

      this.customChestDomeMat = domeMat
      this.customAttachments.push(timerGroup)
      this.customGeometries.push(rimGeo, domeGeo)
      this.customMaterials.push(rimMat, domeMat)
      this.timerMaterials.push(domeMat)
    }
  }

  private calibrateBoneTips(model: THREE.Object3D, profile: HeroProfile) {
    this.root.updateMatrixWorld(true)
    const b = profile.bones

    // 显式解剖关节链：确保上臂->前臂->手腕->中指根、大腿->小腿->脚踝轴向 100% 精准无偏斜
    const directPairs: [string | undefined, string | undefined][] = [
      [b.upperArmL, b.lowerArmL],
      [b.lowerArmL, b.handL],
      [b.handL, b.fingersL.mid[0] ?? b.fingersL.index[0]],
      [b.upperArmR, b.lowerArmR],
      [b.lowerArmR, b.handR],
      [b.handR, b.fingersR.mid[0] ?? b.fingersR.index[0]],
      [b.thighL, b.shinL],
      [b.shinL, b.footL],
      [b.thighR, b.shinR],
      [b.shinR, b.footR],
      [b.spineLower, b.spineUpper],
      [b.spineUpper, b.spineChest],
      [b.spineChest, b.neckUpper ?? b.head],
      [b.neckUpper, b.head],
    ]

    for (const [parentName, childName] of directPairs) {
      if (!parentName || !childName) continue
      const pBone = this.bones.get(parentName)
      const cBone = this.bones.get(childName)
      if (!pBone || !cBone) continue
      cBone.updateWorldMatrix(true, false)
      pBone.updateWorldMatrix(true, false)
      const childWorld = cBone.getWorldPosition(new THREE.Vector3())
      this.boneTips.set(pBone, pBone.worldToLocal(childWorld))
    }

    let tips: Record<string, [number, number, number]> = {}
    model.traverse((node) => {
      const data = (node.userData?.bone_tips ?? null) as Record<string, [number, number, number]> | null
      if (data) tips = data
    })

    for (const bone of this.bones.values()) {
      if (this.boneTips.has(bone)) continue
      const tailArr = tips[bone.name]
      if (tailArr) {
        const worldTail = model.localToWorld(new THREE.Vector3(tailArr[0], tailArr[1], tailArr[2]))
        this.boneTips.set(bone, bone.worldToLocal(worldTail))
        continue
      }
      const childBones = bone.children.filter(
        (c) => (c as THREE.Bone).isBone && !/twist1/i.test(c.name),
      )
      if (childBones.length > 0) {
        const avg = new THREE.Vector3()
        for (const c of childBones) {
          c.updateWorldMatrix(true, false)
          avg.add(c.getWorldPosition(new THREE.Vector3()))
        }
        avg.divideScalar(childBones.length)
        this.boneTips.set(bone, bone.worldToLocal(avg))
      }
    }
  }

  private calibrateLimbNormalsAndFingers(profile: HeroProfile) {
    this.boneRefNormals.clear()
    this.fingerCurlAxes.clear()
    this.fingerBladeQuats.clear()
    this.fingerCurlScales = { L: 1, R: 1 }
    this.footRestRelQuats.clear()
    this.root.updateMatrixWorld(true)

    const b = profile.bones
    const worldFront = new THREE.Vector3(0, 0, -this.sideSign)

    // 1. 标定大腿与小腿在静息直立态下的正前方局部法线（驱动双腿时锁定膝盖朝向正前方）
    for (const legName of [b.thighL, b.shinL, b.thighR, b.shinR]) {
      const legBone = this.bones.get(legName)
      if (!legBone) continue
      const wq = legBone.getWorldQuaternion(new THREE.Quaternion())
      const localFront = worldFront.clone().applyQuaternion(wq.invert()).normalize()
      this.boneRefNormals.set(legBone, localFront)
    }

    // 2. 记录静息站姿下双脚相对于 root 的朝向四元数（保持双脚底面水平贴地）
    const rootQuatInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert()
    for (const [side, footName] of [
      ['L', b.footL],
      ['R', b.footR],
    ] as const) {
      const footBone = this.bones.get(footName)
      if (!footBone) continue
      const footWorldQ = footBone.getWorldQuaternion(new THREE.Quaternion())
      this.footRestRelQuats.set(side, rootQuatInv.clone().multiply(footWorldQ))
    }

    // 3. 标定左右手掌心向内法线与每节指骨的精确局部铰链弯曲轴
    for (const side of ['L', 'R'] as const) {
      const handName = side === 'L' ? b.handL : b.handR
      const forearmName = side === 'L' ? b.lowerArmL : b.lowerArmR
      const fingerRig = side === 'L' ? b.fingersL : b.fingersR

      const handBone = this.bones.get(handName)
      const forearmBone = this.bones.get(forearmName)
      const indexRoot = this.bones.get(fingerRig.index[0] ?? '')
      const pinkyRoot = this.bones.get(fingerRig.pinky[0] ?? '')
      if (!handBone || !indexRoot || !pinkyRoot) continue

      const handPos = handBone.getWorldPosition(new THREE.Vector3())
      const indexPos = indexRoot.getWorldPosition(new THREE.Vector3())
      const pinkyPos = pinkyRoot.getWorldPosition(new THREE.Vector3())
      const knuckleMid = indexPos.clone().add(pinkyPos).multiplyScalar(0.5)

      const handDirWorld = knuckleMid.sub(handPos).normalize()
      const pinkyToIndex = indexPos.clone().sub(pinkyPos).normalize()

      // 解剖左手: handDir × pinkyToIndex 指向掌心内下侧；解剖右手相反
      const palmInWorld =
        side === 'L'
          ? new THREE.Vector3().crossVectors(handDirWorld, pinkyToIndex)
          : new THREE.Vector3().crossVectors(pinkyToIndex, handDirWorld)
      if (palmInWorld.lengthSq() < 1e-6) continue
      palmInWorld.normalize()
      // T-Pose 静息态下掌心必朝向斜下方内侧（y < 0），双重校验确保正反号绝对统一
      if (palmInWorld.y > 0) {
        palmInWorld.negate()
      }

      if (forearmBone) {
        const foreWq = forearmBone.getWorldQuaternion(new THREE.Quaternion())
        const localPalm = palmInWorld.clone().applyQuaternion(foreWq.invert()).normalize()
        this.boneRefNormals.set(forearmBone, localPalm)
      }

      // 测量中指方向与原厂静息预弯角，将扇形分叉指根向中指并拢标定为特摄标准手刀基准态
      const mid0 = this.bones.get(fingerRig.mid[0] ?? '')
      const mid1 = this.bones.get(fingerRig.mid[1] ?? '')
      const mid2 = this.bones.get(fingerRig.mid[2] ?? '')
      if (mid0 && mid1) {
        const p0 = mid0.getWorldPosition(new THREE.Vector3())
        const p1 = mid1.getWorldPosition(new THREE.Vector3())
        const midDirWorld = p1.clone().sub(p0).normalize()
        if (mid2) {
          const p2 = mid2.getWorldPosition(new THREE.Vector3())
          const midNextWorld = p2.sub(p1).normalize()
          const preBend = midDirWorld.angleTo(midNextWorld)
          this.fingerCurlScales[side] = preBend > 0.18 ? 1.0 : 1.42
        } else {
          // 双节指骨模型（无第三末节指骨）提高单节弯曲幅度以握成紧实饱满铁拳
          this.fingerCurlScales[side] = 1.46
        }

        const adductBoneToward = (b0Name: string | undefined, b1Name: string | undefined, ratio: number) => {
          if (!b0Name || !b1Name) return
          const b0 = this.bones.get(b0Name)
          const b1 = this.bones.get(b1Name)
          if (!b0 || !b1 || !b0.parent) return
          b0.updateWorldMatrix(true, false)
          b1.updateWorldMatrix(true, false)
          const curDir = b1.getWorldPosition(new THREE.Vector3()).sub(b0.getWorldPosition(new THREE.Vector3()))
          if (curDir.lengthSq() < 1e-7) return
          curDir.normalize()
          const desDir = curDir.clone().lerp(midDirWorld, ratio).normalize()
          const deltaW = new THREE.Quaternion().setFromUnitVectors(curDir, desDir)
          const newWorldQ = deltaW.multiply(b0.getWorldQuaternion(new THREE.Quaternion()))
          const parentInv = b0.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
          const bladeLocalQ = parentInv.multiply(newWorldQ)
          this.fingerBladeQuats.set(b0, bladeLocalQ)
          b0.quaternion.copy(bladeLocalQ)
          b0.updateWorldMatrix(false, true)
        }

        adductBoneToward(fingerRig.index[0], fingerRig.index[1], 0.88)
        adductBoneToward(fingerRig.ring[0], fingerRig.ring[1], 0.88)
        adductBoneToward(fingerRig.pinky[0], fingerRig.pinky[1], 0.9)
        adductBoneToward(fingerRig.thumb[0], fingerRig.thumb[1], 0.68)
        adductBoneToward(fingerRig.thumb[1], fingerRig.thumb[2], 0.72)
        handBone.updateWorldMatrix(false, true)
      }

      // 在紧密并拢的手刀基准态下计算四指与拇指各关节向掌心弯曲的局部铰链轴
      for (const chain of [fingerRig.index, fingerRig.mid, fingerRig.ring, fingerRig.pinky]) {
        this.calibrateFingerChainAxes(chain, palmInWorld)
      }

      const indexToPinky = pinkyToIndex.clone().negate()
      const thumbTargetWorld = palmInWorld
        .clone()
        .multiplyScalar(0.58)
        .addScaledVector(indexToPinky, 0.42)
        .normalize()
      this.calibrateFingerChainAxes(fingerRig.thumb, thumbTargetWorld)

      // 恢复静息四元数
      for (const [bone, rq] of this.restQuats) {
        bone.quaternion.copy(rq)
      }
      handBone.updateWorldMatrix(false, true)
    }
  }

  private calibrateFingerChainAxes(chain: FingerChain, targetInwardWorld: THREE.Vector3) {
    const validBones = chain
      .map((n) => this.bones.get(n))
      .filter((b): b is THREE.Bone => !!b)
    if (validBones.length === 0) return

    let lastSegDir = new THREE.Vector3(0, -1, 0)
    for (let i = 0; i < validBones.length; i++) {
      const bone = validBones[i]!
      const pos = bone.getWorldPosition(new THREE.Vector3())
      const nextBone = validBones[i + 1]
      if (nextBone) {
        const nextPos = nextBone.getWorldPosition(new THREE.Vector3())
        const d = nextPos.sub(pos)
        if (d.lengthSq() > 1e-7) {
          lastSegDir = d.normalize()
        }
      }
      const axisWorld = new THREE.Vector3().crossVectors(lastSegDir, targetInwardWorld)
      if (axisWorld.lengthSq() < 1e-6) continue
      axisWorld.normalize()
      const boneWq = bone.getWorldQuaternion(new THREE.Quaternion())
      const axisLocal = axisWorld.applyQuaternion(boneWq.invert()).normalize()
      this.fingerCurlAxes.set(bone, axisLocal)
    }
  }

  private unloadModel() {
    if (!this.model) return
    for (const obj of this.customAttachments) {
      obj.parent?.remove(obj)
    }
    for (const geo of this.customGeometries) {
      geo.dispose()
    }
    for (const mat of this.customMaterials) {
      mat.dispose()
    }
    this.customAttachments = []
    this.customGeometries = []
    this.customMaterials = []
    this.customChestDomeMat = null

    for (const entry of this.formSuitEntries) {
      entry.mat.map = entry.originalMap
    }
    for (const tex of this.derivedTextures) {
      tex.dispose()
    }
    this.derivedTextures = []

    this.root.remove(this.model)
    releaseModel(this.model)
    this.model = null
    this.bones.clear()
    this.logical.clear()
    this.restQuats.clear()
    this.restPositions.clear()
    this.boneTips.clear()
    this.boneRefNormals.clear()
    this.fingerCurlAxes.clear()
    this.fingerBladeQuats.clear()
    this.footRestRelQuats.clear()
    this.timerMaterials = []
    this.eyeMaterials = []
    this.formSilverEntries = []
    this.formSuitEntries = []
    this.currentForm = null
  }

  public dispose() {
    this.loadGen++
    this.unloadModel()
    this.root.parent?.remove(this.root)
  }

  public setLean(lean: number) {
    const moveMul = (this.profile?.baseMoveMul ?? 1) * (this.currentForm?.moveMul ?? 1)
    this.targetX = this.sideSign * THREE.MathUtils.clamp(lean, -1, 1) * 5.5 * moveMul
  }

  public setForm(form: HeroFormSpec | null) {
    this.currentForm = form
    for (const entry of this.formSilverEntries) {
      if (!form) {
        entry.mat.color.copy(entry.baseColor)
      } else {
        entry.mat.color.setRGB(
          entry.baseColor.r * form.silverScale[0],
          entry.baseColor.g * form.silverScale[1],
          entry.baseColor.b * form.silverScale[2],
        )
      }
    }
    for (const entry of this.formSuitEntries) {
      entry.mat.color.copy(entry.baseColor)
      const targetMap = form
        ? entry.remappedMaps.get(form.suitRemap) ?? entry.originalMap
        : entry.originalMap
      if (entry.mat.map !== targetMap) {
        entry.mat.map = targetMap
        entry.mat.needsUpdate = true
      }
    }
  }

  public setGuard(active: boolean) {
    this.isGuarding = active
  }

  public setBeamCharge(progress: number, side: 'left' | 'right' = 'right') {
    this.beamChargeVisual = THREE.MathUtils.clamp(progress, 0, 1)
    this.beamArmSide = side
  }

  public setDiscCharge(progress: number, side: 'left' | 'right' | null) {
    this.discChargeVisual = THREE.MathUtils.clamp(progress, 0, 1)
    if (side) this.discChargeSide = side
  }

  public setLiveBodyPose(pose: LiveBodyPose | null, now: number) {
    this.livePose = pose
    if (pose?.active) {
      this.lastLivePoseTime = now
      this.beamArmSide = pose.beamArmSide
    }
  }

  public isLiveTracking(now: number): boolean {
    return !!(this.livePose?.active && now - this.lastLivePoseTime < 650)
  }

  public triggerAction(action: HeroAction, duration: number) {
    this.action = action
    this.actionTime = 0
    this.actionDuration = duration
    if (action === 'victory') {
      this.victoryAscent = 0
    }
  }

  public resetPose() {
    this.action = 'idle'
    this.actionTime = 0
    this.currentX = 0
    this.targetX = 0
    this.combatLungeZ = 0
    this.combatVaultY = 0
    this.beamChargeVisual = 0
    this.discChargeVisual = 0
    this.isGuarding = false
    this.victoryAscent = 0
    this.livePose = null
    this.lastLivePoseTime = -Infinity
    this.smTorsoPitch = 0
    this.smTorsoRoll = 0
    this.smTorsoYaw = 0
    this.smHeadYaw = 0
    this.smHeadPitch = 0
    this.smHeadRoll = 0
    this.smJumpHeight = 0
    this.smCrouchDepth = 0
    this.resetSmoothLimbs()
    if (this.model) {
      this.model.position.y = this.modelBaseY
    }
    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw + (this.profile?.facingYaw ?? 0), 0)
  }

  public getAction(): HeroAction {
    return this.action
  }

  /**
   * 将指定骨骼长轴指向世界方向 worldDir，并可选将骨骼参考法线旋正对齐至 desiredNormalWorld（消除绕骨轴扭转变形）
   */
  private aimBoneWorld(
    boneName: string,
    worldDir: THREE.Vector3,
    weight = 1,
    desiredNormalWorld?: THREE.Vector3,
  ) {
    const bone = this.bones.get(boneName)
    if (!bone) return
    const tipLocal = this.boneTips.get(bone)
    if (!tipLocal) return
    bone.updateWorldMatrix(true, false)
    const origin = bone.getWorldPosition(tmpV1)
    const tipWorld = bone.localToWorld(tmpV2.copy(tipLocal))
    const currentDir = tipWorld.sub(origin)
    if (currentDir.lengthSq() < 1e-6) return
    currentDir.normalize()

    const desiredDir = tmpV3.copy(worldDir)
    if (desiredDir.lengthSq() < 1e-6) return
    desiredDir.normalize()

    const worldQuat = bone.getWorldQuaternion(tmpQ1)
    const delta = tmpQ2.setFromUnitVectors(currentDir, desiredDir)
    const targetWorldQuat = delta.multiply(worldQuat)

    if (desiredNormalWorld) {
      const refLocal = this.boneRefNormals.get(bone)
      if (refLocal) {
        // 将当前参考法线与期望法线投影到垂直于 desiredDir 的平面，求精确扭转补角
        const curNorm = tmpV4.copy(refLocal).applyQuaternion(targetWorldQuat)
        curNorm.addScaledVector(desiredDir, -curNorm.dot(desiredDir))
        const desNorm = tmpV5.copy(desiredNormalWorld)
        desNorm.addScaledVector(desiredDir, -desNorm.dot(desiredDir))
        if (curNorm.lengthSq() > 1e-5 && desNorm.lengthSq() > 1e-5) {
          curNorm.normalize()
          desNorm.normalize()
          const cross = tmpV1.crossVectors(curNorm, desNorm)
          const rollAngle = Math.atan2(desiredDir.dot(cross), curNorm.dot(desNorm))
          tmpQ3.setFromAxisAngle(desiredDir, rollAngle)
          targetWorldQuat.premultiply(tmpQ3)
        }
      }
    }

    const parentWorldQuat = bone.parent
      ? bone.parent.getWorldQuaternion(tmpQ3)
      : tmpQ3.identity()
    const targetLocalQuat = parentWorldQuat.invert().multiply(targetWorldQuat)

    if (weight >= 0.999) {
      bone.quaternion.copy(targetLocalQuat)
    } else {
      bone.quaternion.slerp(targetLocalQuat, THREE.MathUtils.clamp(weight, 0, 1))
    }
    bone.updateWorldMatrix(false, true)
  }

  /** 将指定骨骼指向角色自身阵营前向空间（自动适配 P1 面朝 -Z 与 P2 面朝 +Z，支持法线旋正） */
  private aimBoneArena(
    boneName: string,
    arenaDir: THREE.Vector3,
    weight = 1,
    arenaNormal?: THREE.Vector3,
  ) {
    const s = this.sideSign
    const worldDir = new THREE.Vector3(arenaDir.x * s, arenaDir.y, arenaDir.z * s)
    const worldNormal = arenaNormal
      ? new THREE.Vector3(arenaNormal.x * s, arenaNormal.y, arenaNormal.z * s)
      : undefined
    this.aimBoneWorld(boneName, worldDir, weight, worldNormal)
  }

  /** 保持双脚底面水平贴合并实时补偿马步屈膝下沉高度，杜绝脚踝侧崴、悬空或陷地 */
  private alignStandingFeetAndGround(extraJumpY = 0) {
    if (!this.profile || !this.model) return
    const rootWorldQ = this.root.getWorldQuaternion(new THREE.Quaternion())

    for (const [side, footName] of [
      ['L', this.profile.bones.footL],
      ['R', this.profile.bones.footR],
    ] as const) {
      const footBone = this.bones.get(footName)
      const relQ = this.footRestRelQuats.get(side)
      if (!footBone || !relQ || !footBone.parent) continue
      footBone.parent.updateWorldMatrix(true, false)
      const desiredWorldQ = rootWorldQ.clone().multiply(relQ)
      const parentInv = footBone.parent.getWorldQuaternion(tmpQ1).invert()
      footBone.quaternion.copy(parentInv.multiply(desiredWorldQ))
      footBone.updateWorldMatrix(false, true)
    }

    if (extraJumpY > 0.05) {
      this.model.position.y = this.modelBaseY
      return
    }

    const footL = this.logical.get('footL')
    const footR = this.logical.get('footR')
    if (footL && footR) {
      // 先在基准高度测量屈膝后脚踝的世界 Y，再一次性补偿差值使双脚实踏地面
      this.model.position.y = this.modelBaseY
      this.root.updateMatrixWorld(true)
      const minFootY = Math.min(
        footL.getWorldPosition(tmpV1).y,
        footR.getWorldPosition(tmpV2).y,
      )
      const groundDelta = this.restAnkleY - (minFootY - this.root.position.y)
      this.model.position.y = this.modelBaseY + groundDelta
    }
  }

  /** 先将五指收拢为紧密奥特手刀基准，再按预标定局部铰链轴向掌心自然弯曲成饱满铁拳 */
  private curlHand(side: 'L' | 'R', amount: number) {
    if (!this.profile) return
    const t = THREE.MathUtils.clamp(amount, 0, 1)
    const scale = this.fingerCurlScales[side]
    const map = side === 'L' ? this.profile.bones.fingersL : this.profile.bones.fingersR

    const chains: [FingerChain, readonly number[]][] = [
      [map.index, [0.88, 1.04, 0.72]],
      [map.mid, [0.92, 1.06, 0.75]],
      [map.ring, [0.94, 1.04, 0.75]],
      [map.pinky, [0.96, 1.02, 0.75]],
      [map.thumb, [0.38, 0.56, 0.46]],
    ]

    for (const [chain, jointAngles] of chains) {
      const twoSegBoost = chain.length === 2 ? 1.18 : 1.0
      for (let j = 0; j < chain.length; j++) {
        const bone = this.bones.get(chain[j]!)
        if (!bone) continue
        const baseQ = this.fingerBladeQuats.get(bone) ?? this.restQuats.get(bone)
        if (!baseQ) continue
        bone.quaternion.copy(baseQ)
        if (t > 0.01) {
          const axisLocal = this.fingerCurlAxes.get(bone)
          if (axisLocal) {
            const angle = Math.min(1.64, t * scale * twoSegBoost * (jointAngles[j] ?? 0.6))
            tmpQ1.setFromAxisAngle(axisLocal, angle)
            bone.quaternion.multiply(tmpQ1)
          }
        }
      }
    }
  }

  public getBoneWorldPosition(
    logicalName: string,
    fallbackOffset = new THREE.Vector3(0, 9, -2),
  ): THREE.Vector3 {
    const bone = this.logical.get(logicalName)
    if (bone) {
      bone.updateWorldMatrix(true, false)
      return bone.getWorldPosition(new THREE.Vector3())
    }
    return this.root.position
      .clone()
      .add(
        new THREE.Vector3(
          fallbackOffset.x * this.sideSign,
          fallbackOffset.y,
          fallbackOffset.z * this.sideSign,
        ),
      )
  }

  public getBeamOriginSegment(): [THREE.Vector3, THREE.Vector3] {
    const suffix = this.beamArmSide === 'left' ? 'L' : 'R'
    const sx = this.beamArmSide === 'left' ? -0.6 : 0.6
    const elbow = this.getBoneWorldPosition(`lowerArm${suffix}`, new THREE.Vector3(sx, 8.8, -1.8))
    const wrist = this.getBoneWorldPosition(`hand${suffix}`, new THREE.Vector3(sx, 10.6, -1.8))
    elbow.z -= 0.42 * this.sideSign
    wrist.z -= 0.42 * this.sideSign
    return [elbow, wrist]
  }

  public getDiscOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(
      `hand${suffix}`,
      new THREE.Vector3(side === 'left' ? -2 : 2, 13.5, -1),
    )
    p.y += 1.05
    return p
  }

  public getFistOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    return this.getBoneWorldPosition(
      `hand${suffix}`,
      new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 10, -2.5),
    )
  }

  public getFootOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(
      `foot${suffix}`,
      new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 5.5, -2.2),
    )
    p.z -= 0.6 * this.sideSign
    return p
  }

  private computeCombatLunge(): { z: number; y: number } {
    if (
      this.action === 'idle' ||
      this.action === 'victory' ||
      this.action === 'defeat' ||
      this.actionDuration <= 0
    ) {
      return { z: 0, y: 0 }
    }
    const progress = THREE.MathUtils.clamp(this.actionTime / this.actionDuration, 0, 1)
    const burst =
      progress < 0.35
        ? 1 - Math.pow(1 - progress / 0.35, 2.4)
        : Math.cos(((progress - 0.35) / 0.65) * (Math.PI * 0.5))

    if (this.action === 'punch-left' || this.action === 'punch-right') {
      return { z: burst * 4.2, y: 0 }
    }
    if (this.action === 'punch-heavy') {
      return { z: burst * 6.8, y: Math.sin(progress * Math.PI) * 0.85 }
    }
    if (this.action === 'kick-left' || this.action === 'kick-right') {
      return { z: burst * 7.6, y: Math.sin(progress * Math.PI) * 2.1 }
    }
    if (this.action === 'jump-kick') {
      return { z: burst * 9.2, y: Math.sin(progress * Math.PI) * 4.6 }
    }
    if (this.action === 'disc') {
      return { z: burst * 1.8, y: 0 }
    }
    if (this.action === 'hit') {
      return { z: -Math.sin(progress * Math.PI) * 2.1, y: 0 }
    }
    return { z: 0, y: 0 }
  }

  public update(
    dt: number,
    elapsedTime: number,
    dangerTimer: boolean,
    nowMs = performance.now(),
    inputDt = dt,
  ) {
    if (!this.model) return

    if (this.action !== 'idle' && this.action !== 'victory' && this.action !== 'defeat') {
      this.actionTime += dt
      if (this.actionTime >= this.actionDuration) {
        this.action = 'idle'
        this.actionTime = 0
      }
    } else if (this.action === 'defeat') {
      this.actionTime += dt
    }

    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }
    for (const [bone, pos] of this.restPositions) {
      bone.position.copy(pos)
    }

    this.currentX += (this.targetX - this.currentX) * (1 - Math.exp(-inputDt * 13))

    const lunge = this.computeCombatLunge()
    this.combatLungeZ += (lunge.z - this.combatLungeZ) * (1 - Math.exp(-inputDt * 26))
    this.combatVaultY += (lunge.y - this.combatVaultY) * (1 - Math.exp(-inputDt * 24))

    const idleIntensity = this.profile?.timerIdleIntensity ?? 1.4
    for (const m of this.timerMaterials) {
      if (dangerTimer || this.action === 'defeat') {
        const blink = this.action === 'defeat' ? false : Math.sin(elapsedTime * 11.5) > 0
        if (this.customChestDomeMat === m) {
          m.color.setHex(blink ? 0xff4d6d : 0x551122)
        }
        m.emissive.setHex(blink ? 0xff1f3d : 0x550011)
        m.emissiveIntensity = this.action === 'defeat' ? 0.15 : blink ? 3.0 : 0.35
      } else if (idleIntensity > 0) {
        const hex = this.profile?.accentColor ?? 0x38e8ff
        if (this.customChestDomeMat === m) {
          m.color.setHex(0x7dd3fc)
        }
        m.emissive.setHex(hex)
        m.emissiveIntensity = idleIntensity + Math.sin(elapsedTime * 3.5) * 0.25
      } else {
        m.emissiveIntensity = 0
      }
    }
    for (const m of this.eyeMaterials) {
      m.emissiveIntensity =
        this.action === 'defeat' ? 0.25 : 1.9 + Math.sin(elapsedTime * 2.5) * 0.18
    }

    if (this.action === 'victory') {
      this.updateVictoryAscent(dt)
      return
    }
    if (this.action === 'defeat') {
      this.updateDefeatKneel()
      return
    }

    if (this.isLiveTracking(nowMs) && this.livePose) {
      this.applyLiveBodyPose(this.livePose, inputDt, elapsedTime)
      return
    }

    this.applyProceduralPose(elapsedTime)
  }

  private updateVictoryAscent(dt: number) {
    if (!this.profile || !this.model) return
    this.victoryAscent += dt
    const t = Math.min(1, this.victoryAscent / 2.2)
    const easeUp = t * t
    this.model.position.y = this.modelBaseY
    this.root.position.set(
      this.currentX * (1 - t),
      easeUp * 24,
      this.sideSign * (this.baseZ - easeUp * 10),
    )
    this.root.rotation.set(
      easeUp * 0.28 * this.sideSign,
      this.baseYaw + this.profile.facingYaw + Math.sin(this.victoryAscent * 1.4) * 0.2,
      0,
    )
    this.root.updateMatrixWorld(true)

    const b = this.profile.bones
    this.aimBoneArena(b.thighL, new THREE.Vector3(-0.08, -0.98, 0.12), 1, new THREE.Vector3(0, 0, -1))
    this.aimBoneArena(b.shinL, new THREE.Vector3(-0.06, -0.96, 0.24), 1, new THREE.Vector3(0, 0, -1))
    this.aimBoneArena(b.thighR, new THREE.Vector3(0.08, -0.98, 0.12), 1, new THREE.Vector3(0, 0, -1))
    this.aimBoneArena(b.shinR, new THREE.Vector3(0.06, -0.96, 0.24), 1, new THREE.Vector3(0, 0, -1))

    this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.08, 0.96, -0.25))
    this.aimBoneArena(
      b.lowerArmR,
      new THREE.Vector3(0.04, 0.98, -0.2),
      1,
      new THREE.Vector3(-0.9, 0, -0.4),
    )
    this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.22, -0.92, 0.3))
    this.aimBoneArena(
      b.lowerArmL,
      new THREE.Vector3(-0.15, -0.95, 0.28),
      1,
      new THREE.Vector3(0.9, 0, -0.3),
    )
    this.curlHand('R', 1)
    this.curlHand('L', 1)
    this.root.updateMatrixWorld(true)
  }

  private updateDefeatKneel() {
    if (!this.profile || !this.model) return
    const t = Math.min(1, this.actionTime / 0.55)
    const ease = 1 - Math.pow(1 - t, 3)
    const b = this.profile.bones
    this.model.position.y = this.modelBaseY
    this.root.position.set(this.currentX, -2.5 * ease, this.sideSign * (this.baseZ + 1.4 * ease))
    this.root.rotation.set(0, this.baseYaw + this.profile.facingYaw, 0)
    this.root.updateMatrixWorld(true)

    this.aimBoneArena(
      b.spineLower ?? '',
      new THREE.Vector3(0, 0.88, -0.46),
      ease * 0.7,
    )
    this.aimBoneArena(
      b.thighL,
      new THREE.Vector3(-0.14, -0.15, -0.98),
      ease,
      new THREE.Vector3(-0.12, 0.95, -0.2),
    )
    this.aimBoneArena(
      b.shinL,
      new THREE.Vector3(-0.12, -0.98, 0.16),
      ease,
      new THREE.Vector3(-0.12, 0, -1),
    )
    this.aimBoneArena(
      b.thighR,
      new THREE.Vector3(0.14, -0.82, 0.55),
      ease,
      new THREE.Vector3(0.12, 0.4, -0.9),
    )
    this.aimBoneArena(
      b.shinR,
      new THREE.Vector3(0.12, 0.08, 0.99),
      ease,
      new THREE.Vector3(0.12, -1, 0),
    )
    this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.32, -0.88, -0.32), ease)
    this.aimBoneArena(
      b.lowerArmL,
      new THREE.Vector3(-0.18, -0.92, -0.35),
      ease,
      new THREE.Vector3(0.85, 0, 0.5),
    )
    this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.32, -0.88, -0.32), ease)
    this.aimBoneArena(
      b.lowerArmR,
      new THREE.Vector3(0.18, -0.92, -0.35),
      ease,
      new THREE.Vector3(-0.85, 0, 0.5),
    )
    this.curlHand('L', 0.45)
    this.curlHand('R', 0.45)
    this.root.updateMatrixWorld(true)
  }

  /** 应用标准格斗下盘马步姿态（跨骨骼体系一致，膝盖正对斜前方，绝不侧歪或拧麻花） */
  private applyAthleticStanceLegs(crouchFlex = 0, jumpTuck = 0) {
    if (!this.profile) return
    const b = this.profile.bones
    const flex = THREE.MathUtils.clamp(crouchFlex, 0, 0.72)
    const tuck = THREE.MathUtils.clamp(jumpTuck, 0, 0.55)

    const normL = new THREE.Vector3(-0.12, 0, -1)
    const normR = new THREE.Vector3(0.14, 0, -1)

    this.aimBoneArena(
      b.thighL,
      new THREE.Vector3(-0.12, -0.96 + flex * 0.28 + tuck * 0.35, -0.22 - flex * 0.32 - tuck * 0.38),
      1,
      normL,
    )
    this.aimBoneArena(
      b.shinL,
      new THREE.Vector3(-0.1, -0.98 + flex * 0.22 + tuck * 0.3, 0.16 + flex * 0.42 + tuck * 0.45),
      1,
      normL,
    )
    this.aimBoneArena(
      b.thighR,
      new THREE.Vector3(0.14, -0.97 + flex * 0.26 + tuck * 0.28, -0.06 - flex * 0.28 - tuck * 0.3),
      1,
      normR,
    )
    this.aimBoneArena(
      b.shinR,
      new THREE.Vector3(0.12, -0.97 + flex * 0.2 + tuck * 0.26, 0.18 + flex * 0.38 + tuck * 0.4),
      1,
      normR,
    )
  }

  private applyLiveBodyPose(pose: LiveBodyPose, dt: number, elapsedTime: number) {
    if (!this.profile || !this.model) return
    const b = this.profile.bones
    const baseRate = 22
    const alpha = 1 - Math.exp(-dt * baseRate)
    const s = this.sideSign
    const adaptiveAlpha = (cur: THREE.Vector3, target: Vec3Like | null, fallback: number) => {
      if (!target) return fallback
      tmpV1.set(target.x * s, target.y, target.z * s).normalize()
      if (tmpV1.lengthSq() < 1e-6) return fallback
      const change = 1 - Math.min(1, Math.max(-1, cur.dot(tmpV1)))
      const rate = baseRate + Math.min(75, Math.max(0, change - 0.0012) * 1650)
      return 1 - Math.exp(-dt * rate)
    }

    this.smTorsoPitch = THREE.MathUtils.lerp(this.smTorsoPitch, pose.torsoPitch, alpha)
    this.smTorsoRoll = THREE.MathUtils.lerp(this.smTorsoRoll, pose.torsoRoll, alpha)
    this.smTorsoYaw = THREE.MathUtils.lerp(this.smTorsoYaw, pose.torsoYaw, alpha)
    this.smHeadYaw = THREE.MathUtils.lerp(this.smHeadYaw, pose.headYaw, alpha)
    this.smHeadPitch = THREE.MathUtils.lerp(this.smHeadPitch, pose.headPitch, alpha)
    this.smHeadRoll = THREE.MathUtils.lerp(this.smHeadRoll, pose.headRoll, alpha)
    this.smJumpHeight = THREE.MathUtils.lerp(this.smJumpHeight, pose.jumpHeight, alpha)
    this.smCrouchDepth = THREE.MathUtils.lerp(this.smCrouchDepth, pose.crouchDepth, alpha)

    if (pose.upperArmL)
      lerpArenaVec(this.smUpperL, pose.upperArmL, adaptiveAlpha(this.smUpperL, pose.upperArmL, alpha), s)
    if (pose.lowerArmL)
      lerpArenaVec(this.smLowerL, pose.lowerArmL, adaptiveAlpha(this.smLowerL, pose.lowerArmL, alpha), s)
    if (pose.handL)
      lerpArenaVec(this.smHandL, pose.handL, adaptiveAlpha(this.smHandL, pose.handL, alpha), s)
    else if (pose.lowerArmL) lerpArenaVec(this.smHandL, pose.lowerArmL, alpha, s)

    if (pose.upperArmR)
      lerpArenaVec(this.smUpperR, pose.upperArmR, adaptiveAlpha(this.smUpperR, pose.upperArmR, alpha), s)
    if (pose.lowerArmR)
      lerpArenaVec(this.smLowerR, pose.lowerArmR, adaptiveAlpha(this.smLowerR, pose.lowerArmR, alpha), s)
    if (pose.handR)
      lerpArenaVec(this.smHandR, pose.handR, adaptiveAlpha(this.smHandR, pose.handR, alpha), s)
    else if (pose.lowerArmR) lerpArenaVec(this.smHandR, pose.lowerArmR, alpha, s)

    if (pose.thighL)
      lerpArenaVec(this.smThighL, pose.thighL, adaptiveAlpha(this.smThighL, pose.thighL, alpha), s)
    if (pose.shinL)
      lerpArenaVec(this.smShinL, pose.shinL, adaptiveAlpha(this.smShinL, pose.shinL, alpha), s)
    if (pose.thighR)
      lerpArenaVec(this.smThighR, pose.thighR, adaptiveAlpha(this.smThighR, pose.thighR, alpha), s)
    if (pose.shinR)
      lerpArenaVec(this.smShinR, pose.shinR, adaptiveAlpha(this.smShinR, pose.shinR, alpha), s)

    let hitPitch = 0
    if (this.action === 'hit') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      hitPitch = -0.2 * p
    }

    const totalJumpY = Math.max(this.smJumpHeight, this.combatVaultY)
    this.model.position.y = this.modelBaseY
    this.root.position.set(this.currentX, totalJumpY, this.sideSign * (this.baseZ - this.combatLungeZ))
    this.root.rotation.set(
      0,
      this.baseYaw + this.profile.facingYaw + this.smTorsoYaw * 0.55,
      -this.smTorsoRoll * 0.25 * this.sideSign,
    )
    this.root.updateMatrixWorld(true)

    const totalPitch = this.smTorsoPitch + hitPitch + Math.sin(elapsedTime * 2.4) * 0.012
    if (b.spineChest) {
      this.aimBoneArena(
        b.spineChest,
        new THREE.Vector3(this.smTorsoRoll * 0.35, 1, -totalPitch * 0.65),
        0.65,
      )
    }
    if (b.head) {
      this.aimBoneArena(
        b.head,
        new THREE.Vector3(-this.smHeadYaw * 0.55, 1, -this.smHeadPitch * 0.55 - 0.15),
        0.5,
      )
    }
    this.root.updateMatrixWorld(true)

    const worldLegNormL = new THREE.Vector3(-0.12 * s, 0, -s)
    const worldLegNormR = new THREE.Vector3(0.12 * s, 0, -s)

    if (pose.coverage === 'full' && pose.thighL && pose.thighR) {
      this.aimBoneWorld(b.thighL, this.smThighL, 1, worldLegNormL)
      if (pose.shinL) this.aimBoneWorld(b.shinL, this.smShinL, 1, worldLegNormL)
      this.aimBoneWorld(b.thighR, this.smThighR, 1, worldLegNormR)
      if (pose.shinR) this.aimBoneWorld(b.shinR, this.smShinR, 1, worldLegNormR)
    } else {
      const crouchFlex = THREE.MathUtils.clamp(this.smCrouchDepth * 0.28, 0, 0.72)
      const jumpTuck = THREE.MathUtils.clamp(totalJumpY * 0.14, 0, 0.55)
      this.applyAthleticStanceLegs(crouchFlex, jumpTuck)
    }

    if (this.action === 'jump-kick') {
      const extension = Math.sin((Math.PI * this.actionTime) / this.actionDuration)
      this.aimBoneArena(
        b.thighR,
        new THREE.Vector3(0.12, 0.25, -1),
        extension,
        new THREE.Vector3(0, 1, -0.2),
      )
      this.aimBoneArena(
        b.shinR,
        new THREE.Vector3(0.08, 0.12, -1),
        extension,
        new THREE.Vector3(0, 1, -0.1),
      )
    } else {
      this.alignStandingFeetAndGround(totalJumpY)
    }

    this.root.updateMatrixWorld(true)

    const isBladeHand =
      this.action === 'beam' ||
      this.beamChargeVisual > 0.12 ||
      this.action === 'disc' ||
      this.discChargeVisual > 0.12

    // 为动捕前臂提供符合解剖规律的默认内向掌心朝向，发射光线时竖手掌心朝内呈现标准十字手刀
    const palmNormL = isBladeHand
      ? new THREE.Vector3(0.85 * s, 0, 0.5 * s)
      : new THREE.Vector3(0.65 * s, -0.65, 0.35 * s)
    const palmNormR = isBladeHand
      ? new THREE.Vector3(-0.85 * s, 0, 0.5 * s)
      : new THREE.Vector3(-0.65 * s, -0.65, 0.35 * s)

    if (pose.upperArmL) {
      this.aimBoneWorld(b.upperArmL, this.smUpperL)
      if (pose.lowerArmL) {
        this.aimBoneWorld(b.lowerArmL, this.smLowerL, 1, palmNormL)
        this.aimBoneWorld(b.handL, this.smHandL, 0.45)
      }
    }
    if (pose.upperArmR) {
      this.aimBoneWorld(b.upperArmR, this.smUpperR)
      if (pose.lowerArmR) {
        this.aimBoneWorld(b.lowerArmR, this.smLowerR, 1, palmNormR)
        this.aimBoneWorld(b.handR, this.smHandR, 0.45)
      }
    }

    const curlAmt = isBladeHand
      ? 0.0
      : this.isGuarding
        ? 0.25
        : this.action === 'punch-left' ||
            this.action === 'punch-right' ||
            this.action === 'punch-heavy'
          ? 1.0
          : 0.78
    this.curlHand('L', curlAmt)
    this.curlHand('R', curlAmt)

    this.root.updateMatrixWorld(true)
  }

  private applyProceduralPose(elapsedTime: number) {
    if (!this.profile || !this.model) return
    const b = this.profile.bones
    const leanRatio = THREE.MathUtils.clamp((this.currentX * this.sideSign) / 5.5, -1, 1)
    const breath = Math.sin(elapsedTime * 2.6)
    let bodyYaw = 0
    let bodyPitch = 0.05

    if (this.action === 'punch-left' || this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyYaw = (this.action === 'punch-left' ? -1 : 1) * p * 0.42
      bodyPitch = 0.1 + p * 0.14
    } else if (this.action === 'punch-heavy') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyYaw = p * 0.56
      bodyPitch = 0.12 + p * 0.22
    } else if (
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick'
    ) {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyYaw = (this.action === 'kick-left' ? -1 : 1) * p * 0.44
      bodyPitch = -0.22 * p
    } else if (this.action === 'beam') {
      const p = Math.min(1, this.actionTime / 0.18)
      bodyPitch = -0.04 * p
    } else if (this.action === 'hit') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyPitch = -0.24 * p
    } else if (this.action === 'disc') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyYaw = (this.discChargeSide === 'left' ? -1 : 1) * p * 0.3
    } else if (this.action === 'pose-intro') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      bodyYaw = -0.22 * p
      bodyPitch = -0.06 * p
    }

    this.model.position.y = this.modelBaseY
    this.root.position.set(
      this.currentX,
      this.combatVaultY,
      this.sideSign * (this.baseZ - this.combatLungeZ),
    )
    this.root.rotation.set(
      0,
      this.baseYaw + this.profile.facingYaw + bodyYaw,
      -leanRatio * 0.1 * this.sideSign,
    )
    this.root.updateMatrixWorld(true)

    const isKicking =
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick'

    if (isKicking) {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      const kickUpNorm = new THREE.Vector3(0, 0.9, -0.4)
      const supportNormL = new THREE.Vector3(-0.12, 0, -1)
      const supportNormR = new THREE.Vector3(0.14, 0, -1)

      if (this.action === 'kick-left') {
        this.aimBoneArena(
          b.thighL,
          new THREE.Vector3(-0.12, 0.36 * p - 0.88 * (1 - p), -0.95 * p - 0.16),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(
          b.shinL,
          new THREE.Vector3(-0.06, 0.32 * p - 0.94 * (1 - p), -0.98 * p + 0.12 * (1 - p)),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(b.thighR, new THREE.Vector3(0.14, -0.96, -0.04), 1, supportNormR)
        this.aimBoneArena(b.shinR, new THREE.Vector3(0.12, -0.96, 0.2), 1, supportNormR)
      } else {
        this.aimBoneArena(b.thighL, new THREE.Vector3(-0.12, -0.96, -0.16), 1, supportNormL)
        this.aimBoneArena(b.shinL, new THREE.Vector3(-0.1, -0.96, 0.18), 1, supportNormL)
        this.aimBoneArena(
          b.thighR,
          new THREE.Vector3(0.12, 0.38 * p - 0.88 * (1 - p), -0.95 * p - 0.12),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(
          b.shinR,
          new THREE.Vector3(0.06, 0.34 * p - 0.94 * (1 - p), -0.98 * p + 0.14 * (1 - p)),
          1,
          kickUpNorm,
        )
      }
    } else {
      this.applyAthleticStanceLegs(breath * 0.015, 0)
      this.alignStandingFeetAndGround(this.combatVaultY)
    }

    if (b.spineChest) {
      this.aimBoneArena(
        b.spineChest,
        new THREE.Vector3(0, 1, -(bodyPitch + breath * 0.016) * 0.7),
        0.55,
      )
    }
    this.root.updateMatrixWorld(true)

    const guardPalmL = new THREE.Vector3(0.7, -0.55, 0.45)
    const guardPalmR = new THREE.Vector3(-0.7, -0.55, 0.45)
    const punchPalmDown = new THREE.Vector3(0, -1, 0.15)

    if (this.action === 'beam' || this.beamChargeVisual > 0.08) {
      const isLeftMain = this.beamArmSide === 'left'
      const sx = isLeftMain ? -1 : 1
      const mainUpper = isLeftMain ? b.upperArmL : b.upperArmR
      const mainLower = isLeftMain ? b.lowerArmL : b.lowerArmR
      const subUpper = isLeftMain ? b.upperArmR : b.upperArmL
      const subLower = isLeftMain ? b.lowerArmR : b.lowerArmL

      // 必杀十字手刀：竖手掌心朝身体内侧（手刀外刃正对敌人），横手掌心朝胸口内侧
      this.aimBoneArena(mainUpper, new THREE.Vector3(sx * 0.24, -0.18, -0.95))
      this.aimBoneArena(
        mainLower,
        new THREE.Vector3(-sx * 0.04, 0.99, -0.1),
        1,
        new THREE.Vector3(-sx * 0.95, 0, 0.3),
      )
      this.aimBoneArena(subUpper, new THREE.Vector3(-sx * 0.34, -0.26, -0.9))
      this.aimBoneArena(
        subLower,
        new THREE.Vector3(sx * 0.96, 0.05, -0.24),
        1,
        new THREE.Vector3(0, 0.15, 0.98),
      )
      this.curlHand('L', 0)
      this.curlHand('R', 0)
    } else if (this.isGuarding) {
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.26, -0.1, -0.95))
      this.aimBoneArena(
        b.lowerArmL,
        new THREE.Vector3(0.56, 0.8, -0.2),
        1,
        new THREE.Vector3(0.3, -0.1, 0.95),
      )
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.26, -0.1, -0.95))
      this.aimBoneArena(
        b.lowerArmR,
        new THREE.Vector3(-0.56, 0.8, -0.2),
        1,
        new THREE.Vector3(-0.3, -0.1, 0.95),
      )
      this.curlHand('L', 0.25)
      this.curlHand('R', 0.25)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.14 * (1 - p), 0.14 * p - 0.18 * (1 - p), -0.97))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.05, 0.18 * p + 0.1, -0.98), 1, punchPalmDown)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.52, -0.54, -0.48))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.3, 0.26, -0.9), 1, guardPalmR)
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'punch-right' || this.action === 'punch-heavy') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      const lift = this.action === 'punch-heavy' ? 0.26 : 0.15
      this.aimBoneArena(
        b.upperArmR,
        new THREE.Vector3(0.14 * (1 - p), lift * p - 0.16 * (1 - p), -0.97),
      )
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.05, lift * p + 0.1, -0.98), 1, punchPalmDown)
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.52, -0.5, -0.46))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.32, 0.28, -0.88), 1, guardPalmL)
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'disc' || this.discChargeVisual > 0.08) {
      const isLeft = this.discChargeSide === 'left'
      const activeUpper = isLeft ? b.upperArmL : b.upperArmR
      const activeLower = isLeft ? b.lowerArmL : b.lowerArmR
      const idleUpper = isLeft ? b.upperArmR : b.upperArmL
      const idleLower = isLeft ? b.lowerArmR : b.lowerArmL
      const sx = isLeft ? -1 : 1

      if (this.action === 'disc') {
        const p = Math.min(1, this.actionTime / this.actionDuration)
        const swingY = THREE.MathUtils.lerp(0.85, -0.25, p)
        this.aimBoneArena(activeUpper, new THREE.Vector3(sx * 0.28, swingY, -0.92))
        this.aimBoneArena(
          activeLower,
          new THREE.Vector3(sx * 0.12, swingY - 0.1, -0.98),
          1,
          new THREE.Vector3(-sx * 0.9, -0.3, 0.2),
        )
      } else {
        this.aimBoneArena(activeUpper, new THREE.Vector3(sx * 0.35, 0.92, -0.18))
        this.aimBoneArena(
          activeLower,
          new THREE.Vector3(sx * 0.12, 0.98, -0.15),
          1,
          new THREE.Vector3(-sx * 0.95, 0, 0.25),
        )
      }
      this.aimBoneArena(idleUpper, new THREE.Vector3(-sx * 0.46, -0.52, -0.62))
      this.aimBoneArena(
        idleLower,
        new THREE.Vector3(sx * 0.25, 0.3, -0.92),
        1,
        isLeft ? guardPalmR : guardPalmL,
      )
      this.curlHand(isLeft ? 'L' : 'R', 0)
      this.curlHand(isLeft ? 'R' : 'L', 0.92)
    } else if (this.action === 'pose-intro') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.32, 0.48 * p - 0.3 * (1 - p), -0.82))
      this.aimBoneArena(
        b.lowerArmR,
        new THREE.Vector3(-0.18, 0.85 * p + 0.24 * (1 - p), -0.55),
        1,
        guardPalmR,
      )
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.5, -0.28, -0.75))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.26, 0.52, -0.8), 1, guardPalmL)
      this.curlHand('L', 0.85)
      this.curlHand('R', 0.95)
    } else if (this.action === 'hit') {
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.72, -0.22, -0.45))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(-0.45, 0.42, -0.68), 1, guardPalmL)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.72, -0.22, -0.45))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(0.45, 0.42, -0.68), 1, guardPalmR)
      this.curlHand('L', 0.55)
      this.curlHand('R', 0.55)
    } else {
      const sway = breath * 0.04
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.44, -0.34 + sway, -0.8))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.24, 0.44 + sway, -0.86), 1, guardPalmL)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.5, -0.46 - sway, -0.68))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.2, 0.3 - sway, -0.92), 1, guardPalmR)
      this.curlHand('L', 0.88)
      this.curlHand('R', 0.95)
    }

    this.root.updateMatrixWorld(true)
  }
}
