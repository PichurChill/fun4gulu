import * as THREE from 'three'
import { releaseModel } from './releaseModel'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { FingerChain, HeroFormSpec, HeroProfile, SuitRemapMode } from './heroes'
import type { HeroAction, LiveBodyPose, Vec3Like } from './types'

const tmpV1 = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpQ1 = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()

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
      if (b > g + 10 && b > r * 0.52) {
        const lum = Math.max(r, b)
        d[i] = Math.min(255, Math.round(lum * 1.18 + 14))
        d[i + 1] = Math.round(Math.min(g, lum * 0.28) * 0.55)
        d[i + 2] = Math.round(Math.min(r, g) * 0.35)
      } else if (r > b + 18 && r > g + 18) {
        d[i] = Math.min(255, Math.round(r * 1.08 + 6))
        d[i + 1] = Math.round(g * 0.78)
        d[i + 2] = Math.round(b * 0.72)
      }
    } else if (mode === 'all-violet') {
      if (r > b + 14 && r > g + 14) {
        d[i] = Math.round(r * 0.46 + b * 0.24)
        d[i + 1] = Math.round(g * 0.75 + r * 0.14)
        d[i + 2] = Math.min(255, Math.round(r * 1.04 + 18))
      } else if (b > g + 10) {
        d[i] = Math.round(r * 0.85)
        d[i + 2] = Math.min(255, Math.round(b * 1.1 + 10))
      }
    } else if (mode === 'all-cobalt') {
      if (r > b + 14 && r > g + 14) {
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
  private profile: HeroProfile | null = null
  private loadGen = 0
  private bones = new Map<string, THREE.Bone>()
  private logical = new Map<string, THREE.Bone>()
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private restPositions = new Map<THREE.Bone, THREE.Vector3>()
  private boneTips = new Map<THREE.Bone, THREE.Vector3>()
  private timerMaterials: THREE.MeshStandardMaterial[] = []
  private eyeMaterials: THREE.MeshStandardMaterial[] = []
  private customChestDome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null =
    null

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
    this.smThighL.set(-0.14 * s, -0.96, -0.22 * s).normalize()
    this.smShinL.set(-0.08 * s, -0.98, 0.16 * s).normalize()
    this.smThighR.set(0.16 * s, -0.96, -0.12 * s).normalize()
    this.smShinR.set(0.08 * s, -0.98, 0.14 * s).normalize()
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

    // 加载计算静息包围盒与骨骼尾端前先归零根节点旋转，随后再恢复阵营朝向
    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw + profile.facingYaw, 0)

    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const height = Math.max(0.001, box.max.y - box.min.y)
    const center = box.getCenter(new THREE.Vector3())
    const scale = 13.5 / height
    model.scale.multiplyScalar(scale)
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
    this.root.add(model)
    this.root.updateMatrixWorld(true)

    this.timerMaterials = []
    this.eyeMaterials = []
    this.formSilverEntries = []
    this.formSuitEntries = []
    this.derivedTextures = []
    this.currentForm = null
    const staticAttachments: THREE.Mesh[] = []
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
        if (
          profile.id === 'tiga' &&
          (mesh.name.includes('TigaEyes') || mesh.name.includes('TigaEnergy'))
        ) {
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
              if (!mesh.name.includes('Container')) {
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

    // 为迪迦胸口金色护甲中央镶嵌立体发光彩色计时器宝石（双人对打时正面视角同样晶莹闪耀）
    if (profile.id === 'tiga') {
      const chestBone = this.logical.get('spineChest')
      const neckBone = this.logical.get('neckUpper')
      if (chestBone) {
        this.root.updateMatrixWorld(true)
        const chestPos = chestBone.getWorldPosition(new THREE.Vector3())
        const neckPos = neckBone ? neckBone.getWorldPosition(new THREE.Vector3()) : null
        const domeY = neckPos
          ? THREE.MathUtils.lerp(chestPos.y, neckPos.y, 0.28)
          : chestPos.y + 0.45
        const domeX = chestPos.x

        // 从英雄正前方沿视线方向射线投射至胸甲外表面，精确贴合不悬空
        const rayOrigin = new THREE.Vector3(domeX, domeY, chestPos.z - 4.0 * this.sideSign)
        const rayDir = new THREE.Vector3(0, 0, this.sideSign)
        const raycaster = new THREE.Raycaster(rayOrigin, rayDir, 0.1, 6.0)
        const hits = raycaster
          .intersectObject(model, true)
          .filter((h) => h.object.visible)
        const domeZ =
          hits.length > 0
            ? hits[0]!.point.z - 0.02 * this.sideSign
            : chestPos.z - 0.72 * this.sideSign

        const domeMat = new THREE.MeshStandardMaterial({
          color: 0x7dd3fc,
          emissive: new THREE.Color(profile.accentColor),
          emissiveIntensity: 1.8,
          roughness: 0.14,
          metalness: 0.1,
        })
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), domeMat)
        dome.scale.set(0.92, 1.18, 0.46)
        dome.position.set(domeX, domeY, domeZ)
        dome.rotation.set(0, this.baseYaw, 0)
        this.sceneAttachChestDome(chestBone, dome)
        this.customChestDome = dome
        this.timerMaterials.push(domeMat)
      }
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

    let tips: Record<string, [number, number, number]> = {}
    model.traverse((node) => {
      const data = (node.userData?.bone_tips ?? null) as Record<string, [number, number, number]> | null
      if (data) tips = data
    })
    for (const bone of this.bones.values()) {
      const tailArr = tips[bone.name]
      if (tailArr) {
        const worldTail = model.localToWorld(new THREE.Vector3(tailArr[0], tailArr[1], tailArr[2]))
        this.boneTips.set(bone, bone.worldToLocal(worldTail))
        continue
      }
      const childBones = bone.children.filter((c) => (c as THREE.Bone).isBone)
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

  private sceneAttachChestDome(
    chestBone: THREE.Bone,
    dome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>,
  ) {
    const worldHost = this.root.parent ?? this.root
    worldHost.add(dome)
    worldHost.updateMatrixWorld(true)
    chestBone.updateWorldMatrix(true, false)
    chestBone.attach(dome)
  }

  private unloadModel() {
    if (!this.model) return
    if (this.customChestDome) {
      this.customChestDome.parent?.remove(this.customChestDome)
      this.customChestDome.geometry.dispose()
      this.customChestDome.material.dispose()
      this.customChestDome = null
    }
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
    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw + (this.profile?.facingYaw ?? 0), 0)
  }

  public getAction(): HeroAction {
    return this.action
  }

  /** 将指定骨骼指向纯世界坐标方向向量 */
  private aimBoneWorld(boneName: string, worldDir: THREE.Vector3, weight = 1) {
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

    const parentWorldQuat = bone.parent
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion()
    const targetLocalQuat = parentWorldQuat.invert().multiply(targetWorldQuat)

    if (weight >= 0.999) {
      bone.quaternion.copy(targetLocalQuat)
    } else {
      bone.quaternion.slerp(targetLocalQuat, THREE.MathUtils.clamp(weight, 0, 1))
    }
    bone.updateWorldMatrix(false, true)
  }

  /** 将指定骨骼指向角色自身阵营前向空间（自动适配 P1 面朝 -Z 与 P2 面朝 +Z） */
  private aimBoneArena(boneName: string, arenaDir: THREE.Vector3, weight = 1) {
    this.aimBoneWorld(
      boneName,
      new THREE.Vector3(arenaDir.x * this.sideSign, arenaDir.y, arenaDir.z * this.sideSign),
      weight,
    )
  }

  private getBoneWorldDir(boneName: string): THREE.Vector3 | null {
    const bone = this.bones.get(boneName)
    if (!bone) return null
    const tipLocal = this.boneTips.get(bone)
    if (!tipLocal) return null
    bone.updateWorldMatrix(true, false)
    const origin = bone.getWorldPosition(new THREE.Vector3())
    const tip = bone.localToWorld(new THREE.Vector3().copy(tipLocal))
    const dir = tip.sub(origin)
    if (dir.lengthSq() < 1e-6) return null
    return dir.normalize()
  }

  private curlHand(side: 'L' | 'R', amount: number) {
    if (!this.profile) return
    const t = THREE.MathUtils.clamp(amount, 0, 1)
    if (t < 0.01) return
    const map = side === 'L' ? this.profile.bones.fingersL : this.profile.bones.fingersR
    const handBoneName = side === 'L' ? this.profile.bones.handL : this.profile.bones.handR

    const handDir = this.getBoneWorldDir(handBoneName)
    const indexRoot = this.bones.get(map.index[0]!)
    const pinkyRoot = this.bones.get(map.pinky[0]!)
    if (!handDir || !indexRoot || !pinkyRoot) return

    indexRoot.updateWorldMatrix(true, false)
    pinkyRoot.updateWorldMatrix(true, false)
    const span = pinkyRoot
      .getWorldPosition(new THREE.Vector3())
      .sub(indexRoot.getWorldPosition(new THREE.Vector3()))
    if (span.lengthSq() < 1e-6) return
    span.normalize()

    const palmNormal = new THREE.Vector3().copy(handDir).cross(span)
    if (palmNormal.lengthSq() < 1e-6) return
    palmNormal.normalize()
    const bendAxis = new THREE.Vector3().copy(handDir).cross(palmNormal)
    if (bendAxis.lengthSq() < 1e-6) return
    bendAxis.normalize()

    const chains: [FingerChain, number[]][] = [
      [map.index, [0.95, 1.05, 0.8]],
      [map.mid, [0.95, 1.05, 0.8]],
      [map.ring, [0.95, 1.0, 0.8]],
      [map.pinky, [1.0, 1.0, 0.8]],
      [map.thumb, [0.5, 0.6, 0.5]],
    ]

    for (const [chain, angles] of chains) {
      const restDirs: (THREE.Vector3 | null)[] = []
      for (const name of chain) {
        restDirs.push(this.getBoneWorldDir(name)?.clone() ?? null)
      }
      let cum = 0
      for (let j = 0; j < chain.length; j++) {
        const dir = restDirs[j]
        if (!dir) break
        cum += t * (angles[j] ?? 0.6)
        dir.applyQuaternion(tmpQ1.setFromAxisAngle(bendAxis, cum))
        this.aimBoneWorld(chain[j]!, dir)
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
        if (this.customChestDome?.material === m) {
          m.color.setHex(blink ? 0xff4d6d : 0x551122)
        }
        m.emissive.setHex(blink ? 0xff1f3d : 0x550011)
        m.emissiveIntensity = this.action === 'defeat' ? 0.15 : blink ? 3.0 : 0.35
      } else if (idleIntensity > 0) {
        const hex = this.profile?.accentColor ?? 0x38e8ff
        if (this.customChestDome?.material === m) {
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
        this.action === 'defeat' ? 0.25 : 1.85 + Math.sin(elapsedTime * 2.5) * 0.2
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
    this.victoryAscent += dt
    const t = Math.min(1, this.victoryAscent / 2.2)
    const easeUp = t * t
    this.root.position.set(
      this.currentX * (1 - t),
      easeUp * 24,
      this.sideSign * (this.baseZ - easeUp * 10),
    )
    this.root.rotation.set(
      easeUp * 0.28 * this.sideSign,
      this.baseYaw + (this.profile?.facingYaw ?? 0) + Math.sin(this.victoryAscent * 1.4) * 0.2,
      0,
    )
    this.root.updateMatrixWorld(true)
    this.aimBoneArena(this.profile!.bones.upperArmR, new THREE.Vector3(0.08, 0.96, -0.25))
    this.aimBoneArena(this.profile!.bones.lowerArmR, new THREE.Vector3(0.04, 0.98, -0.2))
    this.aimBoneArena(this.profile!.bones.upperArmL, new THREE.Vector3(-0.22, -0.92, 0.3))
    this.aimBoneArena(this.profile!.bones.lowerArmL, new THREE.Vector3(-0.15, -0.95, 0.28))
    this.curlHand('R', 1)
    this.curlHand('L', 1)
    this.root.updateMatrixWorld(true)
  }

  private updateDefeatKneel() {
    const t = Math.min(1, this.actionTime / 0.55)
    const ease = 1 - Math.pow(1 - t, 3)
    this.root.position.set(this.currentX, -2.6 * ease, this.sideSign * (this.baseZ + 1.5 * ease))
    this.root.rotation.set(0, this.baseYaw + (this.profile?.facingYaw ?? 0), 0)
    const spineLower = this.logical.get('spineLower')
    const spineChest = this.logical.get('spineChest')
    const thighL = this.logical.get('thighL')
    const shinL = this.logical.get('shinL')
    const thighR = this.logical.get('thighR')
    const shinR = this.logical.get('shinR')
    if (spineLower) spineLower.rotation.x += 0.32 * ease
    if (spineChest) spineChest.rotation.x += 0.28 * ease
    if (thighL) thighL.rotation.x += 1.05 * ease
    if (shinL) shinL.rotation.x -= 1.65 * ease
    if (thighR) thighR.rotation.x += 0.45 * ease
    if (shinR) shinR.rotation.x -= 1.45 * ease
    this.root.updateMatrixWorld(true)
    if (this.profile) {
      this.aimBoneArena(this.profile.bones.upperArmL, new THREE.Vector3(-0.35, -0.88, -0.32), ease)
      this.aimBoneArena(this.profile.bones.lowerArmL, new THREE.Vector3(-0.18, -0.92, -0.35), ease)
      this.aimBoneArena(this.profile.bones.upperArmR, new THREE.Vector3(0.35, -0.88, -0.32), ease)
      this.aimBoneArena(this.profile.bones.lowerArmR, new THREE.Vector3(0.18, -0.92, -0.35), ease)
    }
    this.root.updateMatrixWorld(true)
  }

  private applyLiveBodyPose(pose: LiveBodyPose, dt: number, elapsedTime: number) {
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
    this.root.position.set(this.currentX, totalJumpY, this.sideSign * (this.baseZ - this.combatLungeZ))
    this.root.rotation.set(
      0,
      this.baseYaw + (this.profile?.facingYaw ?? 0) + this.smTorsoYaw * 0.45,
      0,
    )
    this.root.updateMatrixWorld(true)

    const spineLower = this.logical.get('spineLower')
    const spineUpper = this.logical.get('spineUpper')
    const spineChest = this.logical.get('spineChest')
    const totalPitch = this.smTorsoPitch + hitPitch
    if (spineLower) {
      spineLower.rotation.x += totalPitch * 0.35
      spineLower.rotation.z += this.smTorsoRoll * 0.35
      spineLower.rotation.y += this.smTorsoYaw * 0.25
    }
    if (spineUpper) {
      spineUpper.rotation.x += totalPitch * 0.35
      spineUpper.rotation.z += this.smTorsoRoll * 0.35
      spineUpper.rotation.y += this.smTorsoYaw * 0.2
    }
    if (spineChest) {
      spineChest.rotation.x += totalPitch * 0.3 + Math.sin(elapsedTime * 2.4) * 0.012
      spineChest.rotation.z += this.smTorsoRoll * 0.3
      spineChest.rotation.y += this.smTorsoYaw * 0.15
    }

    const neckUpper = this.logical.get('neckUpper')
    const head = this.logical.get('head')
    if (neckUpper) {
      neckUpper.rotation.y += this.smHeadYaw * 0.45
      neckUpper.rotation.x += this.smHeadPitch * 0.4
      neckUpper.rotation.z += this.smHeadRoll * 0.4
    }
    if (head) {
      head.rotation.y += this.smHeadYaw * 0.55
      head.rotation.x += this.smHeadPitch * 0.6
      head.rotation.z += this.smHeadRoll * 0.6
    }

    this.root.updateMatrixWorld(true)

    const hip = this.logical.get('hip')
    if (pose.coverage === 'full' && pose.thighL && pose.thighR && this.profile) {
      this.aimBoneWorld(this.profile.bones.thighL, this.smThighL)
      if (pose.shinL) this.aimBoneWorld(this.profile.bones.shinL, this.smShinL)
      this.aimBoneWorld(this.profile.bones.thighR, this.smThighR)
      if (pose.shinR) this.aimBoneWorld(this.profile.bones.shinR, this.smShinR)

      this.root.updateMatrixWorld(true)
      const footL = this.logical.get('footL')
      const footR = this.logical.get('footR')
      if (footL && footR) {
        const minFootY = Math.min(
          footL.getWorldPosition(tmpV1).y,
          footR.getWorldPosition(tmpV2).y,
        )
        const groundDelta = this.restAnkleY - minFootY
        this.root.position.y = Math.max(0, groundDelta + totalJumpY)
      }
    } else {
      const crouchFlex = THREE.MathUtils.clamp(this.smCrouchDepth * 0.28, 0, 0.72)
      const jumpTuck = THREE.MathUtils.clamp(totalJumpY * 0.14, 0, 0.55)
      if (hip) {
        hip.position.y -= 0.05 + crouchFlex * 0.36
      }
      const thighL = this.logical.get('thighL')
      const shinL = this.logical.get('shinL')
      const thighR = this.logical.get('thighR')
      const shinR = this.logical.get('shinR')
      if (thighL && shinL && thighR && shinR) {
        thighL.rotation.x += 0.2 + crouchFlex * 0.85 + jumpTuck * 0.7
        thighL.rotation.z -= 0.14 + crouchFlex * 0.12
        shinL.rotation.x -= 0.32 + crouchFlex * 1.45 + jumpTuck * 1.1
        thighR.rotation.x += 0.12 + crouchFlex * 0.85 + jumpTuck * 0.5
        thighR.rotation.z += 0.16 + crouchFlex * 0.12
        shinR.rotation.x -= 0.24 + crouchFlex * 1.45 + jumpTuck * 0.9
      }
    }

    if (this.action === 'jump-kick' && this.profile) {
      const extension = Math.sin((Math.PI * this.actionTime) / this.actionDuration)
      this.aimBoneArena(this.profile.bones.thighR, new THREE.Vector3(0.12, 0.25, -1), extension)
      this.aimBoneArena(this.profile.bones.shinR, new THREE.Vector3(0.08, 0.12, -1), extension)
    }

    this.root.updateMatrixWorld(true)

    if (this.profile) {
      if (pose.upperArmL) {
        this.aimBoneWorld(this.profile.bones.upperArmL, this.smUpperL)
        if (pose.lowerArmL) {
          this.aimBoneWorld(this.profile.bones.lowerArmL, this.smLowerL)
          this.aimBoneWorld(this.profile.bones.handL, this.smHandL, 0.75)
        }
      }
      if (pose.upperArmR) {
        this.aimBoneWorld(this.profile.bones.upperArmR, this.smUpperR)
        if (pose.lowerArmR) {
          this.aimBoneWorld(this.profile.bones.lowerArmR, this.smLowerR)
          this.aimBoneWorld(this.profile.bones.handR, this.smHandR, 0.75)
        }
      }
    }

    const isBladeHand =
      this.action === 'beam' ||
      this.beamChargeVisual > 0.12 ||
      this.action === 'disc' ||
      this.discChargeVisual > 0.12
    const curlAmt = isBladeHand
      ? 0.0
      : this.isGuarding
        ? 0.22
        : this.action === 'punch-left' ||
            this.action === 'punch-right' ||
            this.action === 'punch-heavy'
          ? 1.0
          : 0.75
    this.curlHand('L', curlAmt)
    this.curlHand('R', curlAmt)

    this.root.updateMatrixWorld(true)
  }

  private applyProceduralPose(elapsedTime: number) {
    if (!this.profile) return
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
      bodyYaw = -0.24 * p
      bodyPitch = -0.08 * p
    }

    this.root.position.set(
      this.currentX,
      this.combatVaultY,
      this.sideSign * (this.baseZ - this.combatLungeZ),
    )
    this.root.rotation.set(
      0,
      this.baseYaw + this.profile.facingYaw + bodyYaw,
      -leanRatio * 0.12 * this.sideSign,
    )
    this.root.updateMatrixWorld(true)

    const hip = this.logical.get('hip')
    if (hip) {
      hip.position.y -= 0.055 + breath * 0.008
    }

    const thighL = this.logical.get('thighL')
    const shinL = this.logical.get('shinL')
    const thighR = this.logical.get('thighR')
    const shinR = this.logical.get('shinR')

    if (
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick'
    ) {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.root.updateMatrixWorld(true)
      if (this.action === 'kick-left') {
        this.aimBoneArena(
          b.thighL,
          new THREE.Vector3(-0.12, 0.36 * p - 0.85 * (1 - p), -0.95 * p - 0.12),
        )
        this.aimBoneArena(b.shinL, new THREE.Vector3(-0.06, 0.32 * p - 0.92 * (1 - p), -0.98 * p))
      } else {
        this.aimBoneArena(
          b.thighR,
          new THREE.Vector3(0.12, 0.38 * p - 0.85 * (1 - p), -0.95 * p - 0.12),
        )
        this.aimBoneArena(b.shinR, new THREE.Vector3(0.06, 0.34 * p - 0.92 * (1 - p), -0.98 * p))
      }
    } else if (thighL && shinL && thighR && shinR) {
      thighL.rotation.x += 0.24
      thighL.rotation.z -= 0.15
      shinL.rotation.x -= 0.36
      thighR.rotation.x += 0.13
      thighR.rotation.z += 0.17
      shinR.rotation.x -= 0.26
    }

    const spineChest = this.logical.get('spineChest')
    if (spineChest) {
      spineChest.rotation.x += bodyPitch + breath * 0.018
    }
    const head = this.logical.get('head')
    if (head) {
      head.rotation.x -= bodyPitch * 0.5
    }
    this.root.updateMatrixWorld(true)

    if (this.action === 'beam' || this.beamChargeVisual > 0.08) {
      const blend = this.action === 'beam' ? 1 : Math.min(1, this.beamChargeVisual * 1.4)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.42, -0.22, -0.88), blend)
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.04, 0.98, -0.18), blend)
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.22, -0.42, -0.88), blend)
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.95, 0.12, -0.28), blend)
      this.curlHand('R', 0)
      this.curlHand('L', 0)
    } else if (this.isGuarding || this.action === 'guard') {
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(0.18, -0.18, -0.96))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.65, 0.65, -0.38))
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(-0.18, -0.18, -0.96))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.65, 0.65, -0.38))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.2)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBoneArena(
        b.upperArmL,
        new THREE.Vector3(-0.16 * (1 - p), 0.16 * p - 0.15 * (1 - p), -0.97),
      )
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.05, 0.18 * p + 0.1, -0.98))
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.55, -0.58, -0.45))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.32, 0.22, -0.9))
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'punch-right' || this.action === 'punch-heavy') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      const lift = this.action === 'punch-heavy' ? 0.28 : 0.16
      this.aimBoneArena(
        b.upperArmR,
        new THREE.Vector3(0.16 * (1 - p), lift * p - 0.15 * (1 - p), -0.97),
      )
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.05, lift * p + 0.1, -0.98))
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.58, -0.52, -0.42))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.34, 0.26, -0.88))
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
        this.aimBoneArena(activeLower, new THREE.Vector3(sx * 0.12, swingY - 0.1, -0.98))
      } else {
        this.aimBoneArena(activeUpper, new THREE.Vector3(sx * 0.35, 0.92, -0.18))
        this.aimBoneArena(activeLower, new THREE.Vector3(sx * 0.12, 0.98, -0.15))
      }
      this.aimBoneArena(idleUpper, new THREE.Vector3(-sx * 0.48, -0.55, -0.62))
      this.aimBoneArena(idleLower, new THREE.Vector3(sx * 0.25, 0.28, -0.92))
      this.curlHand(isLeft ? 'L' : 'R', 0)
      this.curlHand(isLeft ? 'R' : 'L', 0.9)
    } else if (this.action === 'pose-intro') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.32, 0.48 * p - 0.3 * (1 - p), -0.82))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.18, 0.85 * p + 0.24 * (1 - p), -0.55))
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.56, -0.25, -0.75))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.26, 0.55, -0.8))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.95)
    } else if (this.action === 'hit') {
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.78, -0.18, -0.4))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(-0.55, 0.45, -0.68))
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.78, -0.18, -0.4))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(0.55, 0.45, -0.68))
      this.curlHand('L', 0.5)
      this.curlHand('R', 0.5)
    } else {
      const sway = breath * 0.045
      this.aimBoneArena(b.upperArmL, new THREE.Vector3(-0.46, -0.32 + sway, -0.8))
      this.aimBoneArena(b.lowerArmL, new THREE.Vector3(0.24, 0.46 + sway, -0.86))
      this.aimBoneArena(b.upperArmR, new THREE.Vector3(0.54, -0.48 - sway, -0.65))
      this.aimBoneArena(b.lowerArmR, new THREE.Vector3(-0.18, 0.28 - sway, -0.94))
      this.curlHand('L', 0.82)
      this.curlHand('R', 0.95)
    }

    this.root.updateMatrixWorld(true)
  }
}
