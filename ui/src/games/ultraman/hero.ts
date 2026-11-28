import * as THREE from 'three'
import { releaseModel } from './releaseModel'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { FingerChain, HeroFormSpec, HeroProfile, SuitRemapMode } from './heroes'
import type { HeroAction, LiveBodyPose, LiveHandFingers, Vec3Like } from './types'

const tmpV1 = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpV4 = new THREE.Vector3()
const tmpV5 = new THREE.Vector3()
const tmpV6 = new THREE.Vector3()
const tmpV7 = new THREE.Vector3()
const tmpV8 = new THREE.Vector3()
const tmpV9 = new THREE.Vector3()
const tmpV10 = new THREE.Vector3()
const tmpQ1 = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpQ3 = new THREE.Quaternion()
const tmpQ4 = new THREE.Quaternion()
const tmpQ5 = new THREE.Quaternion()
const tmpQ6 = new THREE.Quaternion()

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
 * 四阶段武术发力曲线（Anticipation 蓄势反拉 → Snap 爆发突刺 → Hit-Hold 极点滞留 → Follow-through 惯性收招）
 * - skipAnticipation: 摄像头体感出拳时玩家本人已完成蓄力，直接零反拉爆发突刺，消除“拳打出去了角色先缩手”的别扭感
 */
function evalStrikeCurve(
  progress: number,
  skipAnticipation = false,
): { extend: number; anticipation: number; snap: number } {
  const p = THREE.MathUtils.clamp(progress, 0, 1)
  if (skipAnticipation) {
    if (p < 0.16) {
      const t = p / 0.16
      const ease = 1 - Math.pow(1 - t, 3)
      return { extend: ease, anticipation: 0, snap: ease }
    }
    if (p < 0.34) {
      const t = (p - 0.16) / 0.18
      return { extend: 1 - t * 0.04, anticipation: 0, snap: 1 }
    }
    const t = (p - 0.34) / 0.66
    const rec = Math.cos(t * Math.PI * 0.5)
    return { extend: rec * 0.96, anticipation: 0, snap: rec }
  }
  if (p < 0.14) {
    const t = p / 0.14
    const pull = Math.sin(t * Math.PI)
    return { extend: -0.22 * pull, anticipation: pull, snap: 0 }
  }
  if (p < 0.3) {
    const t = (p - 0.14) / 0.16
    const ease = 1 - Math.pow(1 - t, 3)
    return { extend: ease, anticipation: 0, snap: ease }
  }
  if (p < 0.44) {
    // 极点滞留微压，配合接触帧顿帧产生强烈实打质感
    const t = (p - 0.3) / 0.14
    return { extend: 1 - t * 0.04, anticipation: 0, snap: 1 }
  }
  const t = (p - 0.44) / 0.56
  const rec = Math.cos(t * Math.PI * 0.5)
  return { extend: rec * 0.96, anticipation: 0, snap: rec }
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
      if (r > b + 14 && r > g + 14 && g < r * 0.54) {
        d[i] = Math.round(r * 0.46 + b * 0.24)
        d[i + 1] = Math.round(g * 0.75 + r * 0.14)
        d[i + 2] = Math.min(255, Math.round(r * 1.04 + 18))
      } else if (b > g + 10 && g < b * 0.8) {
        d[i] = Math.round(r * 0.85)
        d[i + 2] = Math.min(255, Math.round(b * 1.1 + 10))
      }
    } else if (mode === 'all-cobalt') {
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

export interface HeroControllerOptions {
  /** 阵营朝向：1 = 南端驻守 +baseZ 面朝 -Z；-1 = 北端驻守 -baseZ 面朝 +Z（双人对战 P2） */
  sideSign?: 1 | -1
  /** 站位距中心基准距离（正数，实际世界 Z = sideSign * baseZ） */
  baseZ?: number
}

export interface StrikeContactInfo {
  active: boolean
  limb: 'handL' | 'handR' | 'footL' | 'footR' | null
  progress: number
}

/**
 * 奥特曼第三人称分层骨骼与特摄武术动力链控制器：
 * - 真解剖发力链（双脚抓地 → 蹬地转胯 → 多节脊柱拧腰 → 锁骨送肩 → 肘背极向量约束防拧 → 铁拳/手刀）
 * - 头部全程 Look-At 死锁目标，告别木偶甩头
 * - 实时动捕英雄体态美化层（自动挺胸开肩、约束肘膝极角、横向迈步防滑冰）
 * - 皮套 Fresnel 轮廓光与受击/蓄力边缘泛光着色器
 */
export class HeroController {
  public readonly root = new THREE.Group()
  public readonly sideSign: 1 | -1
  public baseZ: number
  private targetBaseZ: number
  private leanRange = 5.5
  private readonly baseYaw: number

  private model: THREE.Object3D | null = null
  private modelBaseY = 0
  private profile: HeroProfile | null = null
  private loadGen = 0
  private bones = new Map<string, THREE.Bone>()
  private logical = new Map<string, THREE.Bone>()
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private smoothBoneQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private restPositions = new Map<THREE.Bone, THREE.Vector3>()
  private boneTips = new Map<THREE.Bone, THREE.Vector3>()
  private boneRefNormals = new Map<THREE.Bone, THREE.Vector3>()
  private fingerCurlAxes = new Map<THREE.Bone, THREE.Vector3>()
  private fingerBladeQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private fingerCurlScales: Record<'L' | 'R', number> = { L: 1, R: 1 }
  private footRestRelQuats = new Map<'L' | 'R', THREE.Quaternion>()

  private timerMaterials: THREE.MeshStandardMaterial[] = []
  private eyeMaterials: THREE.MeshStandardMaterial[] = []

  // 皮套共享 Fresnel 轮廓光与蓄力/受击脉冲 Uniform
  private readonly uHeroRimColor = { value: new THREE.Color(0x38e8ff) }
  private readonly uHeroRimStrength = { value: 0.34 }
  private readonly uHeroHitFlash = { value: 0 }
  private heroHitFlash = 0

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
  private lateralSpeed = 0
  private strideCycle = 0
  private action: HeroAction = 'idle'
  private actionTime = 0
  private actionDuration = 0.35
  private actionInstant = false
  private beamChargeVisual = 0
  private discChargeVisual = 0
  private discChargeSide: 'left' | 'right' = 'right'
  private beamArmSide: 'left' | 'right' = 'right'
  private isGuarding = false
  private victoryAscent = 0

  private combatLungeZ = 0
  private combatVaultY = 0
  private minSafeWorldZ = -Infinity

  /** 视线锁定的敌方目标世界坐标（null 时正视前方） */
  private lookTargetWorld: THREE.Vector3 | null = null

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
  private smPalmL = new THREE.Vector3()
  private smPalmR = new THREE.Vector3()
  private smFingersL = { thumb: 0.78, index: 0.78, mid: 0.78, ring: 0.78, pinky: 0.78, splay: 0 }
  private smFingersR = { thumb: 0.78, index: 0.78, mid: 0.78, ring: 0.78, pinky: 0.78, splay: 0 }
  private wasMartial = false
  private postMartialBlend = 0

  constructor(scene: THREE.Scene, opts?: HeroControllerOptions) {
    this.sideSign = opts?.sideSign ?? 1
    this.baseZ = opts?.baseZ ?? 13.2
    this.targetBaseZ = this.baseZ
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
    this.smPalmL.set(0.65 * s, -0.65, 0.35 * s).normalize()
    this.smPalmR.set(-0.65 * s, -0.65, 0.35 * s).normalize()
    this.smFingersL = { thumb: 0.78, index: 0.78, mid: 0.78, ring: 0.78, pinky: 0.78, splay: 0 }
    this.smFingersR = { thumb: 0.78, index: 0.78, mid: 0.78, ring: 0.78, pinky: 0.78, splay: 0 }
    this.wasMartial = false
    this.postMartialBlend = 0
  }

  public get worldZ(): number {
    return this.root.position.z
  }

  public get homeWorldZ(): number {
    return this.sideSign * this.baseZ
  }

  public getTargetCenter(): THREE.Vector3 {
    return new THREE.Vector3(
      this.currentX,
      this.root.position.y + 8.8,
      this.root.position.z - 0.6 * this.sideSign,
    )
  }

  /** 设置英雄锁视目标世界坐标（用于头部实时盯紧怪兽或对手） */
  public setLookTarget(worldPos: THREE.Vector3 | null) {
    if (!worldPos) {
      this.lookTargetWorld = null
      return
    }
    if (!this.lookTargetWorld) this.lookTargetWorld = worldPos.clone()
    else this.lookTargetWorld.copy(worldPos)
  }

  /** 受击皮套闪红反馈 */
  public triggerHurtFlash(strength = 1) {
    this.heroHitFlash = Math.min(1, Math.max(this.heroHitFlash, strength))
  }

  /** 查询当前招式是否处于真实物理接触窗口（Active Hit Frame）及发力肢体 */
  public getStrikeContactInfo(): StrikeContactInfo {
    if (this.actionDuration <= 0) return { active: false, limb: null, progress: 0 }
    const p = THREE.MathUtils.clamp(this.actionTime / this.actionDuration, 0, 1)
    const active = this.actionInstant ? p >= 0.08 && p <= 0.34 : p >= 0.22 && p <= 0.42
    switch (this.action) {
      case 'punch-left':
      case 'hook-left':
      case 'uppercut-left':
      case 'chop-left':
      case 'combo-2':
      case 'combo-4':
        return { active, limb: 'handL', progress: p }
      case 'punch-right':
      case 'hook-right':
      case 'uppercut-right':
      case 'chop-right':
      case 'punch-heavy':
      case 'combo-1':
      case 'combo-3':
        return { active, limb: 'handR', progress: p }
      case 'kick-left':
        return { active, limb: 'footL', progress: p }
      case 'kick-right':
      case 'jump-kick':
      case 'combo-5':
        return { active, limb: 'footR', progress: p }
      default:
        return { active: false, limb: null, progress: p }
    }
  }

  private injectHeroRimShader(mat: THREE.MeshStandardMaterial) {
    mat.customProgramCacheKey = () => 'ultra-hero-rim-v1'
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeroRimColor = this.uHeroRimColor
      shader.uniforms.uHeroRimStrength = this.uHeroRimStrength
      shader.uniforms.uHeroHitFlash = this.uHeroHitFlash
      shader.fragmentShader =
        'uniform vec3 uHeroRimColor;\nuniform float uHeroRimStrength;\nuniform float uHeroHitFlash;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `
          vec3 hViewDir = normalize( vViewPosition + vec3( 0.0001 ) );
          float hNdotV = clamp( abs( dot( normalize( normal ), hViewDir ) ), 0.0, 1.0 );
          float hFresnel = pow( max( 1.0 - hNdotV, 0.0001 ), 2.5 );
          outgoingLight += uHeroRimColor * ( hFresnel * uHeroRimStrength );
          outgoingLight = mix(
            outgoingLight,
            outgoingLight * 1.25 + vec3( 0.85, 0.16, 0.12 ) * ( 0.32 + 0.68 * hFresnel ),
            uHeroHitFlash
          );
          #include <opaque_fragment>
          `,
        )
    }
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
    this.uHeroRimColor.value.setHex(profile.accentColor)
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
        this.smoothBoneQuats.set(bone, bone.quaternion.clone())
        this.restPositions.set(bone, bone.position.clone())
      }
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          staticAttachments.push(mesh)
        }
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial) {
            const hasOrmMaps = !!(m.metalnessMap || m.roughnessMap)
            m.envMapIntensity = 1.38
            if (m.emissiveMap) {
              m.emissive.setHex(0xffffff)
              m.emissiveIntensity = 1.05
            }
            const matches = (names: string[]) =>
              names.some((n) => m.name.includes(n) || mesh.name.includes(n))
            const isTimer =
              profile.timerMaterialNames.length > 0 && matches(profile.timerMaterialNames)
            const isEye = profile.eyeMaterialNames.length > 0 && matches(profile.eyeMaterialNames)

            if (profile.formBodyMaterials && matches(profile.formBodyMaterials.silver)) {
              if (!hasOrmMaps) {
                m.roughness = Math.min(m.roughness, 0.25)
                m.metalness = Math.max(m.metalness, 0.72)
              }
              m.envMapIntensity = 1.54
              this.formSilverEntries.push({ mat: m, baseColor: m.color.clone() })
              this.injectHeroRimShader(m)
            } else if (profile.formBodyMaterials && matches(profile.formBodyMaterials.suit)) {
              if (!hasOrmMaps) {
                m.roughness = 0.42
                m.metalness = 0.16
              }
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
              this.injectHeroRimShader(m)
            } else if (isTimer) {
              if (
                !mesh.name.includes('Shield') &&
                !mesh.name.includes('Ring') &&
                !mesh.name.includes('rim')
              ) {
                this.timerMaterials.push(m)
                m.emissive = new THREE.Color(profile.accentColor)
                m.emissiveIntensity = Math.min(1.45, profile.timerIdleIntensity)
                m.roughness = 0.12
              }
            } else if (isEye) {
              this.eyeMaterials.push(m)
              if (m.emissiveMap) {
                m.emissive.setHex(0xffffff)
              } else {
                m.emissive = new THREE.Color(0xffe699)
              }
              m.emissiveIntensity = 0.92
              m.roughness = 0.14
            } else if (/gold|amber/i.test(m.name)) {
              if (!hasOrmMaps) {
                m.roughness = Math.min(m.roughness, 0.22)
                m.metalness = Math.max(m.metalness, 0.84)
              }
              m.envMapIntensity = 1.56
              this.injectHeroRimShader(m)
            } else if (/crystal/i.test(m.name)) {
              m.envMapIntensity = 1.62
              m.roughness = Math.min(m.roughness, 0.1)
            } else {
              if (!hasOrmMaps && !/rim/i.test(m.name)) {
                m.roughness = 0.42
                m.metalness = 0.2
              }
              this.injectHeroRimShader(m)
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
        this.smoothBoneQuats.set(child, child.quaternion.clone())
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

    this.root.updateMatrixWorld(true)
    const armLX = this.logical.get('upperArmL')!.getWorldPosition(new THREE.Vector3()).x * this.sideSign
    const armRX = this.logical.get('upperArmR')!.getWorldPosition(new THREE.Vector3()).x * this.sideSign
    if (armLX >= armRX) {
      throw new Error(
        `[HeroRig] ${profile.id} 左右肢体骨骼映射颠倒: armLX=${armLX.toFixed(3)}, armRX=${armRX.toFixed(3)}`,
      )
    }

    this.calibrateBoneTips(model, profile)
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

  private calibrateBoneTips(model: THREE.Object3D, profile: HeroProfile) {
    this.root.updateMatrixWorld(true)
    const b = profile.bones

    const directPairs: [string | undefined, string | undefined][] = [
      [b.collarL, b.upperArmL],
      [b.upperArmL, b.lowerArmL],
      [b.lowerArmL, b.handL],
      [b.handL, b.fingersL.mid[0] ?? b.fingersL.index[0]],
      [b.collarR, b.upperArmR],
      [b.upperArmR, b.lowerArmR],
      [b.lowerArmR, b.handR],
      [b.handR, b.fingersR.mid[0] ?? b.fingersR.index[0]],
      [b.thighL, b.shinL],
      [b.shinL, b.footL],
      [b.thighR, b.shinR],
      [b.shinR, b.footR],
      [b.spineLower, b.spineUpper],
      [b.spineUpper, b.spineChest],
      [b.spineChest, b.neckLower ?? b.neckUpper ?? b.head],
      [b.neckLower, b.neckUpper ?? b.head],
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
    const worldBack = new THREE.Vector3(0, 0, this.sideSign)

    for (const legName of [b.thighL, b.shinL, b.thighR, b.shinR]) {
      const legBone = this.bones.get(legName)
      if (!legBone) continue
      const wq = legBone.getWorldQuaternion(new THREE.Quaternion())
      const localFront = worldFront.clone().applyQuaternion(wq.invert()).normalize()
      this.boneRefNormals.set(legBone, localFront)
    }

    for (const armName of [b.upperArmL, b.upperArmR]) {
      const armBone = this.bones.get(armName)
      if (!armBone) continue
      const wq = armBone.getWorldQuaternion(new THREE.Quaternion())
      const localBack = worldBack.clone().applyQuaternion(wq.invert()).normalize()
      this.boneRefNormals.set(armBone, localBack)
    }

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

      const palmInWorld =
        side === 'L'
          ? new THREE.Vector3().crossVectors(handDirWorld, pinkyToIndex)
          : new THREE.Vector3().crossVectors(pinkyToIndex, handDirWorld)
      if (palmInWorld.lengthSq() < 1e-6) continue
      palmInWorld.normalize()
      if (palmInWorld.y > 0) {
        palmInWorld.negate()
      }

      if (forearmBone) {
        const foreWq = forearmBone.getWorldQuaternion(new THREE.Quaternion())
        const localPalm = palmInWorld.clone().applyQuaternion(foreWq.invert()).normalize()
        this.boneRefNormals.set(forearmBone, localPalm)
      }
      {
        const handWq = handBone.getWorldQuaternion(new THREE.Quaternion())
        const localHandPalm = palmInWorld.clone().applyQuaternion(handWq.invert()).normalize()
        this.boneRefNormals.set(handBone, localHandPalm)
      }

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
        adductBoneToward(fingerRig.thumb[1], fingerRig.thumb[2], 0.25)
        handBone.updateWorldMatrix(false, true)
      }

      for (const chain of [fingerRig.index, fingerRig.mid, fingerRig.ring, fingerRig.pinky]) {
        this.calibrateFingerChainAxes(chain, palmInWorld)
      }

      const indexToPinky = pinkyToIndex.clone().negate()
      const thumbTargetWorld = palmInWorld
        .clone()
        .multiplyScalar(0.34)
        .addScaledVector(indexToPinky, 0.88)
        .normalize()
      this.calibrateFingerChainAxes(fingerRig.thumb, thumbTargetWorld)

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
    this.smoothBoneQuats.clear()
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

  public setStageBaseZ(z: number, instant = false) {
    this.targetBaseZ = z
    if (instant) this.baseZ = z
  }

  public setLeanRange(range: number) {
    this.leanRange = range
  }

  public setMinSafeWorldZ(z: number) {
    this.minSafeWorldZ = z
  }

  public setLean(lean: number) {
    const moveMul = (this.profile?.baseMoveMul ?? 1) * (this.currentForm?.moveMul ?? 1)
    const rawX = this.sideSign * THREE.MathUtils.clamp(lean, -1, 1) * this.leanRange * moveMul
    this.targetX = THREE.MathUtils.clamp(rawX, -9.6, 9.6)
  }

  public setForm(form: HeroFormSpec | null) {
    this.currentForm = form
    this.uHeroRimColor.value.setHex(form?.accentColor ?? this.profile?.accentColor ?? 0x38e8ff)
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

  public triggerAction(action: HeroAction, duration: number, instant = false) {
    this.action = action
    this.actionTime = 0
    this.actionDuration = duration
    this.actionInstant = instant
    if (action === 'victory') {
      this.victoryAscent = 0
    }
    if (action === 'hit' || action === 'hit-left' || action === 'hit-right' || action === 'hit-heavy') {
      this.triggerHurtFlash(action === 'hit-heavy' ? 1.0 : 0.78)
    }
  }

  public resetPose() {
    this.action = 'idle'
    this.actionTime = 0
    this.actionInstant = false
    this.currentX = 0
    this.targetX = 0
    this.lateralSpeed = 0
    this.strideCycle = 0
    this.combatLungeZ = 0
    this.combatVaultY = 0
    this.beamChargeVisual = 0
    this.discChargeVisual = 0
    this.isGuarding = false
    this.victoryAscent = 0
    this.heroHitFlash = 0
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
    for (const [bone, rq] of this.restQuats) {
      this.smoothBoneQuats.set(bone, rq.clone())
    }
    if (this.model) {
      this.model.position.y = this.modelBaseY
    }
    this.root.position.set(0, 0, this.sideSign * this.baseZ)
    this.root.rotation.set(0, this.baseYaw + (this.profile?.facingYaw ?? 0), 0)
  }

  public getAction(): HeroAction {
    return this.action
  }

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

  private aimBoneArena(
    boneName: string,
    arenaDir: THREE.Vector3,
    weight = 1,
    arenaNormal?: THREE.Vector3,
  ) {
    const s = this.sideSign
    tmpV6.set(arenaDir.x * s, arenaDir.y, arenaDir.z * s)
    if (arenaNormal) {
      tmpV7.set(arenaNormal.x * s, arenaNormal.y, arenaNormal.z * s)
      this.aimBoneWorld(boneName, tmpV6, weight, tmpV7)
    } else {
      this.aimBoneWorld(boneName, tmpV6, weight)
    }
  }

  /** 根据肘弯平面构造大臂肘背法线（零 GC 复用临时向量，杜绝肩膀三角肌拧扯） */
  private computeElbowBackNormalArena(
    upperArena: THREE.Vector3,
    lowerArena: THREE.Vector3,
    side: 'L' | 'R',
    out: THREE.Vector3,
  ): THREE.Vector3 {
    tmpV8.copy(upperArena).normalize()
    tmpV9.copy(lowerArena).normalize()
    const sideOut = side === 'L' ? -0.32 : 0.32
    out.set(sideOut, -0.45, 0.82).normalize()
    tmpV10.copy(tmpV9).negate()
    tmpV10.addScaledVector(tmpV8, -tmpV10.dot(tmpV8))
    const sinLen = tmpV10.length()
    if (sinLen < 0.16) return out
    tmpV10.divideScalar(sinLen)
    const blend = THREE.MathUtils.clamp((sinLen - 0.16) / 0.34, 0, 1)
    return out.lerp(tmpV10, blend).normalize()
  }

  /** 统一驱动完整单侧臂链（锁骨联动 → 大臂含肘背法线防拧 → 前臂含掌心旋正 → 顺手腕） */
  private driveArenaArmChain(
    side: 'L' | 'R',
    upperArena: THREE.Vector3,
    lowerArena: THREE.Vector3,
    palmArena: THREE.Vector3,
    curlAmount: number,
    splayAmount = 0,
  ) {
    if (!this.profile) return
    const b = this.profile.bones
    const s = this.sideSign
    const uNorm = tmpV8.copy(upperArena).normalize()
    tmpV6.set(uNorm.x * s, uNorm.y, uNorm.z * s)
    this.driveCollarForArm(side === 'L' ? b.collarL : b.collarR, side, tmpV6)

    const elbowBack = this.computeElbowBackNormalArena(upperArena, lowerArena, side, tmpV9)
    this.aimBoneArena(side === 'L' ? b.upperArmL : b.upperArmR, upperArena, 1, elbowBack)
    this.aimBoneArena(side === 'L' ? b.lowerArmL : b.lowerArmR, lowerArena, 1, palmArena)
    this.aimBoneArena(side === 'L' ? b.handL : b.handR, lowerArena, 0.55, palmArena)
    this.curlHandFingers(side, {
      thumb: curlAmount,
      index: curlAmount,
      mid: curlAmount,
      ring: curlAmount,
      pinky: curlAmount,
      splay: splayAmount,
    })
  }

  private applyArenaEulerDelta(boneName: string | undefined, yaw: number, pitch: number, roll: number) {
    if (!boneName) return
    if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4 && Math.abs(roll) < 1e-4) return
    const bone = this.bones.get(boneName)
    if (!bone || !bone.parent) return
    bone.updateWorldMatrix(true, false)

    const s = this.sideSign
    tmpQ4.setFromAxisAngle(tmpV1.set(0, 1, 0), yaw)
    tmpQ5.setFromAxisAngle(tmpV2.set(s, 0, 0), -pitch)
    tmpQ6.setFromAxisAngle(tmpV3.set(0, 0, s), roll)
    tmpQ4.multiply(tmpQ5).multiply(tmpQ6)

    const curWorldQ = bone.getWorldQuaternion(tmpQ1)
    const targetWorldQ = tmpQ4.multiply(curWorldQ)
    const parentInv = bone.parent.getWorldQuaternion(tmpQ2).invert()
    bone.quaternion.copy(parentInv.multiply(targetWorldQ))
    bone.updateWorldMatrix(false, true)
  }

  /** 分级驱动脊柱链（腰→腹→胸），让扭转与前俯呈现人类弹性弧线 */
  private driveSpineChain(yaw: number, pitch: number, roll: number) {
    if (!this.profile) return
    const b = this.profile.bones
    const spineChain = [b.spineLower, b.spineUpper, b.spineChest].filter(
      (n): n is string => !!n && this.bones.has(n),
    )
    const weights =
      spineChain.length === 3
        ? [0.28, 0.34, 0.38]
        : spineChain.length === 2
          ? [0.44, 0.56]
          : [1.0]
    for (let i = 0; i < spineChain.length; i++) {
      const w = weights[i]!
      this.applyArenaEulerDelta(spineChain[i], yaw * w, pitch * w, roll * w)
    }
  }

  /** 让颈部与头部死锁目标（反向抵消躯干拧转角，出拳/闪避时眼神始终死盯怪兽） */
  private driveHeadLookLock(counterYaw: number, counterPitch: number, counterRoll: number, weight = 0.82) {
    if (!this.profile) return
    const b = this.profile.bones
    const headBone = this.logical.get('head')
    let targetYaw = 0
    let targetPitch = 0
    if (this.lookTargetWorld && headBone) {
      headBone.updateWorldMatrix(true, false)
      const headPos = headBone.getWorldPosition(tmpV1)
      const dx = (this.lookTargetWorld.x - headPos.x) * this.sideSign
      const dy = this.lookTargetWorld.y - headPos.y
      const dz = (this.lookTargetWorld.z - headPos.z) * this.sideSign
      const forward = Math.max(2.5, -dz)
      // 阵营空间：-dx 表示向左，对应正 yaw
      targetYaw = THREE.MathUtils.clamp(Math.atan2(-dx, forward), -0.52, 0.52)
      targetPitch = THREE.MathUtils.clamp(Math.atan2(-dy, forward), -0.34, 0.28)
    }

    const yaw = THREE.MathUtils.clamp((targetYaw - counterYaw) * weight, -0.78, 0.78)
    const pitch = THREE.MathUtils.clamp((targetPitch - counterPitch) * weight, -0.45, 0.4)
    const roll = THREE.MathUtils.clamp(-counterRoll * 0.65, -0.32, 0.32)

    const chain = [b.neckLower, b.neckUpper, b.head].filter(
      (n): n is string => !!n && this.bones.has(n),
    )
    const weights = chain.length === 3 ? [0.22, 0.34, 0.44] : chain.length === 2 ? [0.4, 0.6] : [1.0]
    for (let i = 0; i < chain.length; i++) {
      const w = weights[i]!
      this.applyArenaEulerDelta(chain[i], yaw * w, pitch * w, roll * w)
    }
  }

  private driveCollarForArm(collarName: string | undefined, side: 'L' | 'R', armDirWorld: THREE.Vector3) {
    if (!collarName) return
    const s = this.sideSign
    const lift = THREE.MathUtils.clamp((armDirWorld.y + 0.32) / 1.12, -0.18, 1)
    const reach = THREE.MathUtils.clamp((-armDirWorld.z * s - 0.12) / 0.85, -0.22, 1)
    const sideDir = side === 'R' ? 1 : -1
    const collarRoll = sideDir * lift * 0.24
    const collarYaw = sideDir * reach * 0.2
    this.applyArenaEulerDelta(collarName, collarYaw, 0, collarRoll)
  }

  private alignStandingFeetAndGround(extraJumpY = 0) {
    if (!this.profile || !this.model) return
    const rootWorldQ = this.root.getWorldQuaternion(tmpQ4)

    for (const [side, footName] of [
      ['L', this.profile.bones.footL],
      ['R', this.profile.bones.footR],
    ] as const) {
      const footBone = this.bones.get(footName)
      const relQ = this.footRestRelQuats.get(side)
      if (!footBone || !relQ || !footBone.parent) continue
      footBone.parent.updateWorldMatrix(true, false)
      tmpQ5.copy(rootWorldQ).multiply(relQ)
      const parentInv = footBone.parent.getWorldQuaternion(tmpQ1).invert()
      footBone.quaternion.copy(parentInv.multiply(tmpQ5))
      footBone.updateWorldMatrix(false, true)
    }

    if (extraJumpY > 0.05) {
      this.model.position.y = this.modelBaseY
      return
    }

    const footL = this.logical.get('footL')
    const footR = this.logical.get('footR')
    if (footL && footR) {
      this.model.position.y = this.modelBaseY
      this.model.updateMatrixWorld(false)
      footL.updateWorldMatrix(true, false)
      footR.updateWorldMatrix(true, false)
      const minFootY = Math.min(
        footL.getWorldPosition(tmpV1).y,
        footR.getWorldPosition(tmpV2).y,
      )
      const groundDelta = this.restAnkleY - (minFootY - this.root.position.y)
      this.model.position.y = this.modelBaseY + groundDelta
    }
  }

  private curlHandFingers(
    side: 'L' | 'R',
    fingers: {
      thumb: number
      index: number
      mid: number
      ring: number
      pinky: number
      splay: number
    },
  ) {
    if (!this.profile) return
    const scale = this.fingerCurlScales[side]
    const map = side === 'L' ? this.profile.bones.fingersL : this.profile.bones.fingersR
    const splay = THREE.MathUtils.clamp(fingers.splay, 0, 1)

    const chains: [FingerChain, number, readonly number[]][] = [
      [map.index, THREE.MathUtils.clamp(fingers.index, 0, 1), [0.88, 1.04, 0.72]],
      [map.mid, THREE.MathUtils.clamp(fingers.mid, 0, 1), [0.92, 1.06, 0.75]],
      [map.ring, THREE.MathUtils.clamp(fingers.ring, 0, 1), [0.94, 1.04, 0.75]],
      [map.pinky, THREE.MathUtils.clamp(fingers.pinky, 0, 1), [0.96, 1.02, 0.75]],
      [map.thumb, THREE.MathUtils.clamp(fingers.thumb, 0, 1), [0.36, 0.62, 0.54]],
    ]

    for (const [chain, curl, jointAngles] of chains) {
      const twoSegBoost = chain.length === 2 ? 1.18 : 1.0
      const fingerSplay = splay * (1 - curl * 0.85)
      for (let j = 0; j < chain.length; j++) {
        const bone = this.bones.get(chain[j]!)
        if (!bone) continue
        const bladeQ = this.fingerBladeQuats.get(bone)
        const restQ = this.restQuats.get(bone)
        if (!bladeQ && !restQ) continue

        if (bladeQ && restQ && fingerSplay > 0.01) {
          bone.quaternion.copy(bladeQ).slerp(restQ, fingerSplay)
        } else {
          bone.quaternion.copy(bladeQ ?? restQ!)
        }

        if (curl > 0.01) {
          const axisLocal = this.fingerCurlAxes.get(bone)
          if (axisLocal) {
            const angle = Math.min(1.64, curl * scale * twoSegBoost * (jointAngles[j] ?? 0.6))
            tmpQ1.setFromAxisAngle(axisLocal, angle)
            bone.quaternion.multiply(tmpQ1)
          }
        }
      }
    }
  }

  private curlHand(side: 'L' | 'R', amount: number) {
    const t = THREE.MathUtils.clamp(amount, 0, 1)
    this.curlHandFingers(side, {
      thumb: t,
      index: t,
      mid: t,
      ring: t,
      pinky: t,
      splay: 0,
    })
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

  private isMartialOverrideAction(): boolean {
    return (
      this.action === 'transform' ||
      this.action === 'pose-intro' ||
      this.action === 'combo-1' ||
      this.action === 'combo-2' ||
      this.action === 'combo-3' ||
      this.action === 'combo-4' ||
      this.action === 'combo-5' ||
      this.action === 'punch-left' ||
      this.action === 'punch-right' ||
      this.action === 'hook-left' ||
      this.action === 'hook-right' ||
      this.action === 'uppercut-left' ||
      this.action === 'uppercut-right' ||
      this.action === 'chop-left' ||
      this.action === 'chop-right' ||
      this.action === 'punch-heavy' ||
      this.action === 'palm-left' ||
      this.action === 'palm-right' ||
      this.action === 'dodge-left' ||
      this.action === 'dodge-right' ||
      this.action === 'crouch-dodge' ||
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick' ||
      this.action === 'guard-parry' ||
      this.action === 'disc' ||
      this.action === 'grapple' ||
      this.action === 'grapple-throw' ||
      this.action === 'backflip-land' ||
      this.action === 'cinematic-taunt' ||
      this.action === 'beam-spread' ||
      this.action === 'beam' ||
      this.action === 'hit' ||
      this.action === 'hit-left' ||
      this.action === 'hit-right' ||
      this.action === 'hit-heavy'
    )
  }

  private applyBoneSmoothing(dt: number, fastAction: boolean, gentleReturn = 0, liveMode = false) {
    // 实时动捕取消过重的第三层阻尼（拉高至 44），告别“抬手慢半拍”的黏滞延迟
    const rate = liveMode
      ? THREE.MathUtils.lerp(44, 24, THREE.MathUtils.clamp(gentleReturn, 0, 1))
      : fastAction
        ? this.actionInstant
          ? 52
          : 34
        : 24
    const alpha = 1 - Math.exp(-Math.max(0.001, dt) * rate)
    for (const [bone, prevQ] of this.smoothBoneQuats) {
      prevQ.slerp(bone.quaternion, alpha)
      bone.quaternion.copy(prevQ)
    }
    this.root.updateMatrixWorld(true)
  }

  private computeCombatLunge(): { z: number; y: number } {
    if (
      this.action === 'idle' ||
      this.action === 'victory' ||
      this.action === 'defeat' ||
      this.action === 'transform' ||
      this.action === 'grapple' ||
      this.action === 'beam-spread' ||
      this.action === 'cinematic-taunt' ||
      this.actionDuration <= 0
    ) {
      return { z: 0, y: 0 }
    }
    const progress = THREE.MathUtils.clamp(this.actionTime / this.actionDuration, 0, 1)
    const { extend } = evalStrikeCurve(progress, this.actionInstant)
    const burst = Math.max(0, extend)

    if (
      this.action === 'punch-left' ||
      this.action === 'punch-right' ||
      this.action === 'combo-1' ||
      this.action === 'combo-2'
    ) {
      return { z: burst * 2.15, y: 0 }
    }
    if (
      this.action === 'hook-left' ||
      this.action === 'hook-right' ||
      this.action === 'chop-left' ||
      this.action === 'chop-right' ||
      this.action === 'combo-4'
    ) {
      return { z: burst * 2.45, y: Math.sin(progress * Math.PI) * 0.42 }
    }
    if (this.action === 'uppercut-left' || this.action === 'uppercut-right' || this.action === 'combo-3') {
      return { z: burst * 2.3, y: Math.sin(progress * Math.PI) * 1.05 }
    }
    if (this.action === 'punch-heavy') {
      return { z: burst * 2.85, y: Math.sin(progress * Math.PI) * 0.9 }
    }
    if (this.action === 'combo-5' || this.action === 'kick-left' || this.action === 'kick-right') {
      return { z: burst * 2.95, y: Math.sin(progress * Math.PI) * 2.35 }
    }
    if (this.action === 'jump-kick') {
      return { z: burst * 3.55, y: Math.sin(progress * Math.PI) * 4.4 }
    }
    if (this.action === 'palm-left' || this.action === 'palm-right') {
      return { z: burst * 1.25, y: 0 }
    }
    if (this.action === 'dodge-left' || this.action === 'dodge-right') {
      return { z: -Math.sin(progress * Math.PI) * 0.75, y: Math.sin(progress * Math.PI) * 0.65 }
    }
    if (this.action === 'crouch-dodge') {
      return { z: -Math.sin(progress * Math.PI) * 0.55, y: 0 }
    }
    if (this.action === 'guard-parry') {
      return { z: burst * 1.15, y: 0 }
    }
    if (this.action === 'grapple-throw') {
      return { z: burst * 2.4, y: Math.sin(progress * Math.PI) * 0.75 }
    }
    if (this.action === 'backflip-land') {
      const air = Math.min(1, progress / 0.62)
      return {
        z: -THREE.MathUtils.lerp(0, 5.2, air),
        y: Math.sin(air * Math.PI) * 7.4,
      }
    }
    if (this.action === 'disc') {
      return { z: burst * 1.65, y: 0 }
    }
    if (this.action === 'hit-heavy') {
      return { z: -Math.sin(progress * Math.PI) * 3.1, y: Math.sin(progress * Math.PI) * 0.45 }
    }
    if (this.action === 'hit' || this.action === 'hit-left' || this.action === 'hit-right') {
      return { z: -Math.sin(progress * Math.PI) * 2.0, y: 0 }
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

    if (
      this.action !== 'idle' &&
      this.action !== 'victory' &&
      this.action !== 'defeat' &&
      this.action !== 'grapple' &&
      this.action !== 'beam-spread' &&
      this.action !== 'transform'
    ) {
      this.actionTime += dt
      if (this.actionTime >= this.actionDuration) {
        this.action = 'idle'
        this.actionTime = 0
      }
    } else if (
      this.action === 'defeat' ||
      this.action === 'grapple' ||
      this.action === 'beam-spread' ||
      this.action === 'transform'
    ) {
      this.actionTime += dt
    }

    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }
    for (const [bone, pos] of this.restPositions) {
      bone.position.copy(pos)
    }

    this.baseZ += (this.targetBaseZ - this.baseZ) * (1 - Math.exp(-inputDt * 6.5))
    const prevX = this.currentX
    this.currentX += (this.targetX - this.currentX) * (1 - Math.exp(-inputDt * 18))
    const instVelX = (this.currentX - prevX) / Math.max(0.004, inputDt)
    this.lateralSpeed += (instVelX - this.lateralSpeed) * (1 - Math.exp(-inputDt * 14))
    if (Math.abs(this.lateralSpeed) > 0.35) {
      this.strideCycle += Math.abs(this.lateralSpeed) * inputDt * 1.45
    }

    const lunge = this.computeCombatLunge()
    this.combatLungeZ += (lunge.z - this.combatLungeZ) * (1 - Math.exp(-inputDt * 26))
    this.combatVaultY += (lunge.y - this.combatVaultY) * (1 - Math.exp(-inputDt * 24))

    // 更新皮套轮廓光与受击闪红
    this.heroHitFlash = Math.max(0, this.heroHitFlash - inputDt * 4.2)
    this.uHeroHitFlash.value = this.heroHitFlash
    const chargingBoost = Math.max(this.beamChargeVisual, this.discChargeVisual)
    const actionRimBoost =
      this.action === 'beam' || this.action === 'beam-spread' || this.action === 'transform'
        ? 0.95
        : this.action === 'guard-parry' || this.isGuarding
          ? 0.65
          : chargingBoost * 0.65
    this.uHeroRimStrength.value = 0.34 + actionRimBoost + Math.sin(elapsedTime * 3.0) * 0.05

    const idleIntensity = this.profile?.timerIdleIntensity ?? 1.4
    for (const m of this.timerMaterials) {
      if (dangerTimer || this.action === 'defeat') {
        const blink = this.action === 'defeat' ? false : Math.sin(elapsedTime * 11.5) > 0
        m.color.setHex(blink ? 0xff6b84 : 0x551122)
        m.emissive.setHex(blink ? 0xff1f3d : 0x550011)
        m.emissiveIntensity = this.action === 'defeat' ? 0.15 : blink ? 3.2 : 0.35
      } else if (idleIntensity > 0) {
        const hex = this.currentForm?.accentColor ?? this.profile?.accentColor ?? 0x38e8ff
        m.color.setHex(0xb8ecff)
        m.emissive.setHex(hex)
        m.emissiveIntensity = idleIntensity + Math.sin(elapsedTime * 3.5) * 0.28
      } else {
        m.emissiveIntensity = 0
      }
    }
    for (const m of this.eyeMaterials) {
      m.emissiveIntensity =
        this.action === 'defeat' ? 0.22 : 0.92 + Math.sin(elapsedTime * 2.5) * 0.03
    }

    if (this.action === 'victory') {
      this.updateVictoryAscent(dt)
      this.applyBoneSmoothing(inputDt, false)
      return
    }
    if (this.action === 'defeat') {
      this.updateDefeatKneel()
      this.applyBoneSmoothing(inputDt, false)
      return
    }

    const useMartial = this.isMartialOverrideAction()
    if (this.wasMartial && !useMartial) {
      this.postMartialBlend = 0.12
    }
    this.wasMartial = useMartial
    if (!useMartial && this.postMartialBlend > 0) {
      this.postMartialBlend = Math.max(0, this.postMartialBlend - inputDt)
    }

    if (!useMartial && this.isLiveTracking(nowMs) && this.livePose) {
      this.applyLiveBodyPose(this.livePose, inputDt, elapsedTime)
      this.applyBoneSmoothing(inputDt, false, this.postMartialBlend / 0.12, true)
      return
    }

    this.applyProceduralPose(elapsedTime)
    this.applyBoneSmoothing(inputDt, useMartial)
  }

  private updateVictoryAscent(dt: number) {
    if (!this.profile || !this.model) return
    this.victoryAscent += dt
    const t = Math.min(1, this.victoryAscent / 0.85)
    const ease = 1 - Math.pow(1 - t, 3)
    const breath = Math.sin(this.victoryAscent * 2.4)
    this.model.position.y = this.modelBaseY
    this.root.position.set(
      THREE.MathUtils.lerp(this.currentX, -3.4 * this.sideSign, ease),
      0,
      this.sideSign * THREE.MathUtils.lerp(this.baseZ, 12.2, ease),
    )
    this.root.rotation.set(
      0,
      this.baseYaw + this.profile.facingYaw + Math.PI * ease + 0.18 * ease,
      0,
    )
    this.root.updateMatrixWorld(true)

    this.applyAthleticStanceLegs(0.06, 0, 0)
    this.alignStandingFeetAndGround(0)

    this.driveSpineChain(0.12, -0.05 + breath * 0.015, 0)
    this.driveArenaArmChain(
      'R',
      new THREE.Vector3(0.42, 0.74 + breath * 0.03, -0.52),
      new THREE.Vector3(0.16, 0.95, -0.26),
      new THREE.Vector3(-0.75, 0.1, 0.65),
      0.0,
    )
    this.driveArenaArmChain(
      'L',
      new THREE.Vector3(-0.46, -0.58, -0.62),
      new THREE.Vector3(0.28, 0.24, -0.92),
      new THREE.Vector3(0.7, -0.55, 0.45),
      0.9,
    )
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

    this.driveSpineChain(0, 0.48 * ease, 0)
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
    this.driveArenaArmChain(
      'L',
      new THREE.Vector3(-0.32, -0.88, -0.32),
      new THREE.Vector3(-0.18, -0.92, -0.35),
      new THREE.Vector3(0.85, 0, 0.5),
      0.45,
    )
    this.driveArenaArmChain(
      'R',
      new THREE.Vector3(0.32, -0.88, -0.32),
      new THREE.Vector3(0.18, -0.92, -0.35),
      new THREE.Vector3(-0.85, 0, 0.5),
      0.45,
    )
    this.root.updateMatrixWorld(true)
  }

  /**
   * 格斗下盘马步与横向真实迈步（步幅随横向移动速度动态驱动，告别平移滑冰感）
   */
  private applyAthleticStanceLegs(crouchFlex = 0, jumpTuck = 0, strideAmp = 0) {
    if (!this.profile) return
    const b = this.profile.bones
    const flex = THREE.MathUtils.clamp(crouchFlex, 0, 0.85)
    const tuck = THREE.MathUtils.clamp(jumpTuck, 0, 0.6)
    const step = Math.sin(this.strideCycle) * THREE.MathUtils.clamp(strideAmp, 0, 1) * 0.24
    const stepLiftL = Math.max(0, step) * 0.6
    const stepLiftR = Math.max(0, -step) * 0.6

    // 差异化格斗下盘宽窄（戴拿宽步刚猛，迪迦前后错步优雅）
    const stanceSpread = this.profile.id === 'dyna' ? 0.19 : this.profile.id === 'zero' ? 0.17 : 0.14

    const normL = new THREE.Vector3(-stanceSpread, 0, -1)
    const normR = new THREE.Vector3(stanceSpread, 0, -1)

    this.aimBoneArena(
      b.thighL,
      new THREE.Vector3(
        -stanceSpread - step * 0.35,
        -0.95 + flex * 0.34 + tuck * 0.36 + stepLiftL * 0.4,
        -0.24 - flex * 0.36 - tuck * 0.38 - step * 0.45,
      ),
      1,
      normL,
    )
    this.aimBoneArena(
      b.shinL,
      new THREE.Vector3(
        -stanceSpread * 0.8 - step * 0.2,
        -0.97 + flex * 0.25 + tuck * 0.32,
        0.18 + flex * 0.46 + tuck * 0.48 + stepLiftL * 0.5,
      ),
      1,
      normL,
    )
    this.aimBoneArena(
      b.thighR,
      new THREE.Vector3(
        stanceSpread - step * 0.35,
        -0.96 + flex * 0.32 + tuck * 0.3 + stepLiftR * 0.4,
        -0.06 - flex * 0.3 - tuck * 0.32 + step * 0.45,
      ),
      1,
      normR,
    )
    this.aimBoneArena(
      b.shinR,
      new THREE.Vector3(
        stanceSpread * 0.85 - step * 0.2,
        -0.96 + flex * 0.24 + tuck * 0.28,
        0.18 + flex * 0.42 + tuck * 0.44 + stepLiftR * 0.5,
      ),
      1,
      normR,
    )
  }

  /**
   * 实时全身动捕 + 英雄体态美化层：
   * 自动挺胸开肩、约束肘膝极角、叠加横向迈步与头部视线微锁，让普通人动作化为光之巨人英姿
   */
  private applyLiveBodyPose(pose: LiveBodyPose, dt: number, elapsedTime: number) {
    if (!this.profile || !this.model) return
    const b = this.profile.bones
    // 提速动捕向量跟随基频（由 22 提至 38），消除手挥出后的拖拽滞后感
    const baseRate = 38
    const alpha = 1 - Math.exp(-dt * baseRate)
    const s = this.sideSign
    const adaptiveAlpha = (cur: THREE.Vector3, target: Vec3Like | null, fallback: number) => {
      if (!target) return fallback
      tmpV1.set(target.x * s, target.y, target.z * s).normalize()
      if (tmpV1.lengthSq() < 1e-6) return fallback
      const change = 1 - Math.min(1, Math.max(-1, cur.dot(tmpV1)))
      const rate = baseRate + Math.min(95, Math.max(0, change - 0.001) * 1900)
      return 1 - Math.exp(-dt * rate)
    }

    // 英雄体态美化：抑制含胸并限制夸张歪身
    const heroPitchTarget = THREE.MathUtils.clamp(pose.torsoPitch * 0.85 + 0.04, -0.28, 0.42)
    const heroRollTarget = THREE.MathUtils.clamp(pose.torsoRoll * 0.78, -0.34, 0.34)
    const heroYawTarget = THREE.MathUtils.clamp(pose.torsoYaw * 0.92, -0.68, 0.68)

    this.smTorsoPitch = THREE.MathUtils.lerp(this.smTorsoPitch, heroPitchTarget, alpha)
    this.smTorsoRoll = THREE.MathUtils.lerp(this.smTorsoRoll, heroRollTarget, alpha)
    this.smTorsoYaw = THREE.MathUtils.lerp(this.smTorsoYaw, heroYawTarget, alpha)
    this.smHeadYaw = THREE.MathUtils.lerp(this.smHeadYaw, pose.headYaw, alpha)
    this.smHeadPitch = THREE.MathUtils.lerp(this.smHeadPitch, pose.headPitch, alpha)
    this.smHeadRoll = THREE.MathUtils.lerp(this.smHeadRoll, pose.headRoll, alpha)
    this.smJumpHeight = THREE.MathUtils.lerp(this.smJumpHeight, pose.jumpHeight, alpha)
    this.smCrouchDepth = THREE.MathUtils.lerp(this.smCrouchDepth, pose.crouchDepth, alpha)

    // 手臂体态美化与深度安全夹紧：防单目 Z 噪声把手臂折进背后或胸甲穿模
    const beautifyUpperArm = (v: Vec3Like | null, side: 'L' | 'R'): Vec3Like | null => {
      if (!v) return null
      const safeZ = THREE.MathUtils.clamp(v.z, -1, 0.42)
      const outX = side === 'L' ? -0.14 : 0.14
      const relaxedDown = v.y < -0.78 && Math.abs(v.x) < 0.25
      if (relaxedDown) {
        return { x: v.x + outX, y: v.y * 0.92, z: Math.min(safeZ, -0.18) }
      }
      return safeZ === v.z ? v : { x: v.x, y: v.y, z: safeZ }
    }
    const clampLowerArm = (v: Vec3Like | null): Vec3Like | null => {
      if (!v) return null
      const safeZ = THREE.MathUtils.clamp(v.z, -1, 0.38)
      return safeZ === v.z ? v : { x: v.x, y: v.y, z: safeZ }
    }

    const uL = beautifyUpperArm(pose.upperArmL, 'L')
    const lL = clampLowerArm(pose.lowerArmL)
    const uR = beautifyUpperArm(pose.upperArmR, 'R')
    const lR = clampLowerArm(pose.lowerArmR)

    if (uL) lerpArenaVec(this.smUpperL, uL, adaptiveAlpha(this.smUpperL, uL, alpha), s)
    if (lL) lerpArenaVec(this.smLowerL, lL, adaptiveAlpha(this.smLowerL, lL, alpha), s)
    if (pose.handL) lerpArenaVec(this.smHandL, pose.handL, adaptiveAlpha(this.smHandL, pose.handL, alpha), s)
    else if (lL) lerpArenaVec(this.smHandL, lL, alpha, s)

    if (uR) lerpArenaVec(this.smUpperR, uR, adaptiveAlpha(this.smUpperR, uR, alpha), s)
    if (lR) lerpArenaVec(this.smLowerR, lR, adaptiveAlpha(this.smLowerR, lR, alpha), s)
    if (pose.handR) lerpArenaVec(this.smHandR, pose.handR, adaptiveAlpha(this.smHandR, pose.handR, alpha), s)
    else if (lR) lerpArenaVec(this.smHandR, lR, alpha, s)

    if (pose.thighL)
      lerpArenaVec(this.smThighL, pose.thighL, adaptiveAlpha(this.smThighL, pose.thighL, alpha), s)
    if (pose.shinL)
      lerpArenaVec(this.smShinL, pose.shinL, adaptiveAlpha(this.smShinL, pose.shinL, alpha), s)
    if (pose.thighR)
      lerpArenaVec(this.smThighR, pose.thighR, adaptiveAlpha(this.smThighR, pose.thighR, alpha), s)
    if (pose.shinR)
      lerpArenaVec(this.smShinR, pose.shinR, adaptiveAlpha(this.smShinR, pose.shinR, alpha), s)

    const totalJumpY = Math.max(this.smJumpHeight, this.combatVaultY)
    this.model.position.y = this.modelBaseY
    let liveWorldZ = this.sideSign * (this.baseZ - this.combatLungeZ)
    if (this.sideSign === 1 && Number.isFinite(this.minSafeWorldZ)) {
      liveWorldZ = Math.max(liveWorldZ, this.minSafeWorldZ)
    }

    // 根节点仅承担 24% 水平转腰，保持双脚稳健踩地，76% 扭转交给骨盆与多节脊柱！
    const rootYawDelta = this.smTorsoYaw * 0.24
    this.root.position.set(this.currentX, totalJumpY, liveWorldZ)
    this.root.rotation.set(0, this.baseYaw + this.profile.facingYaw + rootYawDelta, 0)
    this.root.updateMatrixWorld(true)

    const breath = Math.sin(elapsedTime * 2.5)
    const hipYaw = this.smTorsoYaw * 0.24
    const spineYaw = this.smTorsoYaw * 0.52
    const totalPitch = this.smTorsoPitch + this.smCrouchDepth * 0.1 + breath * 0.015
    const spineRoll = this.smTorsoRoll * 0.85

    if (b.hip) this.applyArenaEulerDelta(b.hip, hipYaw, 0, 0)
    this.driveSpineChain(spineYaw, totalPitch, spineRoll)

    // 动捕头颈融合：70% 尊重玩家转头 + 30% 自然锁定前方目标
    const neckHeadChain = [b.neckLower, b.neckUpper, b.head].filter(
      (n): n is string => !!n && this.bones.has(n),
    )
    const nhWeights =
      neckHeadChain.length === 3 ? [0.2, 0.32, 0.48] : neckHeadChain.length === 2 ? [0.38, 0.62] : [1.0]
    for (let i = 0; i < neckHeadChain.length; i++) {
      const w = nhWeights[i]!
      this.applyArenaEulerDelta(
        neckHeadChain[i],
        this.smHeadYaw * 0.76 * w,
        this.smHeadPitch * 0.78 * w,
        this.smHeadRoll * 0.7 * w,
      )
    }
    this.root.updateMatrixWorld(true)

    const worldLegNormL = new THREE.Vector3(-0.14 * s, 0, -s)
    const worldLegNormR = new THREE.Vector3(0.14 * s, 0, -s)
    const strideAmp = THREE.MathUtils.clamp(Math.abs(this.lateralSpeed) / 7.5, 0, 1)

    if (pose.coverage === 'full' && pose.thighL && pose.thighR && strideAmp < 0.35) {
      this.aimBoneWorld(b.thighL, this.smThighL, 1, worldLegNormL)
      if (pose.shinL) this.aimBoneWorld(b.shinL, this.smShinL, 1, worldLegNormL)
      this.aimBoneWorld(b.thighR, this.smThighR, 1, worldLegNormR)
      if (pose.shinR) this.aimBoneWorld(b.shinR, this.smShinR, 1, worldLegNormR)
    } else {
      const crouchFlex = THREE.MathUtils.clamp(this.smCrouchDepth * 0.32 + 0.08, 0.06, 0.82)
      const jumpTuck = THREE.MathUtils.clamp(totalJumpY * 0.14, 0, 0.55)
      this.applyAthleticStanceLegs(crouchFlex, jumpTuck, strideAmp)
    }
    this.alignStandingFeetAndGround(totalJumpY)
    this.root.updateMatrixWorld(true)

    const isBladeHand = this.beamChargeVisual > 0.12 || this.discChargeVisual > 0.12

    const computeElbowBackWorld = (
      upper: THREE.Vector3,
      lower: THREE.Vector3,
      hasLower: boolean,
      side: 'L' | 'R',
    ): THREE.Vector3 => {
      const sideOut = side === 'L' ? -0.28 * s : 0.28 * s
      const fallback = new THREE.Vector3(sideOut, -0.45, 0.85 * s).normalize()
      if (!hasLower) return fallback
      const bendBack = lower.clone().negate()
      bendBack.addScaledVector(upper, -bendBack.dot(upper))
      const sinLen = bendBack.length()
      if (sinLen < 0.18) return fallback
      bendBack.divideScalar(sinLen)
      const blend = THREE.MathUtils.clamp((sinLen - 0.18) / 0.35, 0, 1)
      return fallback.lerp(bendBack, blend).normalize()
    }

    const defaultPalmL = isBladeHand
      ? new THREE.Vector3(0.85 * s, 0, 0.5 * s).normalize()
      : new THREE.Vector3(0.65 * s, -0.65, 0.35 * s).normalize()
    const defaultPalmR = isBladeHand
      ? new THREE.Vector3(-0.85 * s, 0, 0.5 * s).normalize()
      : new THREE.Vector3(-0.65 * s, -0.65, 0.35 * s).normalize()

    const palmAlpha = 1 - Math.exp(-dt * 26)
    const handTrackL = !isBladeHand && pose.fingersL?.palmNormal ? pose.fingersL : null
    const handTrackR = !isBladeHand && pose.fingersR?.palmNormal ? pose.fingersR : null

    if (handTrackL?.palmNormal) lerpArenaVec(this.smPalmL, handTrackL.palmNormal, palmAlpha, s)
    else this.smPalmL.lerp(defaultPalmL, palmAlpha).normalize()
    if (handTrackR?.palmNormal) lerpArenaVec(this.smPalmR, handTrackR.palmNormal, palmAlpha, s)
    else this.smPalmR.lerp(defaultPalmR, palmAlpha).normalize()

    if (pose.upperArmL) {
      this.driveCollarForArm(b.collarL, 'L', this.smUpperL)
      const elbowBackL = computeElbowBackWorld(this.smUpperL, this.smLowerL, !!pose.lowerArmL, 'L')
      this.aimBoneWorld(b.upperArmL, this.smUpperL, 1, elbowBackL)
      if (pose.lowerArmL) {
        this.aimBoneWorld(b.lowerArmL, this.smLowerL, 1, this.smPalmL)
        this.aimBoneWorld(b.handL, this.smHandL, handTrackL ? 0.78 : 0.48, this.smPalmL)
      }
    }
    if (pose.upperArmR) {
      this.driveCollarForArm(b.collarR, 'R', this.smUpperR)
      const elbowBackR = computeElbowBackWorld(this.smUpperR, this.smLowerR, !!pose.lowerArmR, 'R')
      this.aimBoneWorld(b.upperArmR, this.smUpperR, 1, elbowBackR)
      if (pose.lowerArmR) {
        this.aimBoneWorld(b.lowerArmR, this.smLowerR, 1, this.smPalmR)
        this.aimBoneWorld(b.handR, this.smHandR, handTrackR ? 0.78 : 0.48, this.smPalmR)
      }
    }

    const fallbackCurl = isBladeHand ? 0.0 : this.isGuarding ? 0.22 : 0.78
    const fingerAlpha = 1 - Math.exp(-dt * 28)
    const smoothFingerSide = (
      dst: { thumb: number; index: number; mid: number; ring: number; pinky: number; splay: number },
      src: LiveHandFingers | null | undefined,
    ) => {
      const useSrc = !isBladeHand && src
      dst.thumb = THREE.MathUtils.lerp(dst.thumb, useSrc ? src.thumb : fallbackCurl, fingerAlpha)
      dst.index = THREE.MathUtils.lerp(dst.index, useSrc ? src.index : fallbackCurl, fingerAlpha)
      dst.mid = THREE.MathUtils.lerp(dst.mid, useSrc ? src.mid : fallbackCurl, fingerAlpha)
      dst.ring = THREE.MathUtils.lerp(dst.ring, useSrc ? src.ring : fallbackCurl, fingerAlpha)
      dst.pinky = THREE.MathUtils.lerp(dst.pinky, useSrc ? src.pinky : fallbackCurl, fingerAlpha)
      dst.splay = THREE.MathUtils.lerp(dst.splay, useSrc ? src.splay : 0, fingerAlpha)
    }
    smoothFingerSide(this.smFingersL, pose.fingersL)
    smoothFingerSide(this.smFingersR, pose.fingersR)
    this.curlHandFingers('L', this.smFingersL)
    this.curlHandFingers('R', this.smFingersR)

    this.root.updateMatrixWorld(true)
  }

  /**
   * 英雄差异化特摄待机双臂架势（迪迦半掌太极 / 赛罗高拳嚣张 / 戴拿刚猛拳架 / 泽塔双刃快反）
   */
  private applyHeroIdleArms(breath: number) {
    if (!this.profile) return
    const sway = breath * 0.042
    const guardPalmL = new THREE.Vector3(0.7, -0.55, 0.45)
    const guardPalmR = new THREE.Vector3(-0.7, -0.55, 0.45)

    if (this.profile.id === 'tiga') {
      // 迪迦招牌：左手前探微张手刀半掌、右手紧握收腰蓄势
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.32, -0.18 + sway, -0.92),
        new THREE.Vector3(0.18, 0.48 + sway, -0.86),
        new THREE.Vector3(0.86, -0.15, 0.48),
        0.16,
        0.18,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.54, -0.52 - sway, -0.66),
        new THREE.Vector3(-0.22, 0.28 - sway, -0.92),
        guardPalmR,
        0.95,
      )
    } else if (this.profile.id === 'zero') {
      // 赛罗招牌：双拳高架略微偏侧，随时爆发高速连打
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.42, -0.12 + sway, -0.88),
        new THREE.Vector3(0.32, 0.62 + sway, -0.72),
        guardPalmL,
        0.94,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.48, -0.26 - sway, -0.84),
        new THREE.Vector3(-0.28, 0.56 - sway, -0.78),
        guardPalmR,
        0.96,
      )
    } else if (this.profile.id === 'dyna') {
      // 戴拿招牌：宽肩刚猛低抱拳架，随时重拳轰击
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.56, -0.36 + sway, -0.74),
        new THREE.Vector3(0.34, 0.4 + sway, -0.85),
        guardPalmL,
        0.98,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.58, -0.4 - sway, -0.7),
        new THREE.Vector3(-0.34, 0.36 - sway, -0.86),
        guardPalmR,
        0.98,
      )
    } else {
      // 泽塔招牌：前倾灵活双刀防反架势
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.38, -0.22 + sway, -0.9),
        new THREE.Vector3(0.22, 0.54 + sway, -0.8),
        new THREE.Vector3(0.82, -0.35, 0.45),
        0.35,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.48, -0.36 - sway, -0.8),
        new THREE.Vector3(-0.24, 0.42 - sway, -0.88),
        guardPalmR,
        0.9,
      )
    }
  }

  private applyProceduralPose(elapsedTime: number) {
    if (!this.profile || !this.model) return
    const b = this.profile.bones
    const leanRatio = THREE.MathUtils.clamp((this.currentX * this.sideSign) / Math.max(4, this.leanRange), -1, 1)
    const breath = Math.sin(elapsedTime * 2.8)
    const progress =
      this.actionDuration > 0 ? THREE.MathUtils.clamp(this.actionTime / this.actionDuration, 0, 1) : 0
    const snapArc = Math.sin(progress * Math.PI)
    const { extend: strikeExtend, snap: strikeSnap } = evalStrikeCurve(progress, this.actionInstant)
    const strikePos = Math.max(0, strikeExtend)

    // 关键改进：脚底 rootYaw 仅用于整体转身演出（transform / 360° 旋风踢），普通出拳不再拧脚搓地！
    let rootYaw = 0
    let hipYaw = 0
    let spineYaw = 0
    let spinePitch = 0.08 + breath * 0.015
    let spineRoll = -leanRatio * 0.12
    let extraFlipPitch = 0
    let lockHead = true

    if (this.action === 'combo-1' || this.action === 'punch-right') {
      hipYaw = strikeExtend * 0.24
      spineYaw = strikeExtend * 0.46
      spinePitch = 0.14 + strikePos * 0.2
    } else if (this.action === 'combo-2' || this.action === 'punch-left') {
      hipYaw = -strikeExtend * 0.24
      spineYaw = -strikeExtend * 0.46
      spinePitch = 0.14 + strikePos * 0.18
    } else if (this.action === 'hook-right') {
      hipYaw = strikeExtend * 0.34
      spineYaw = strikeExtend * 0.62
      spinePitch = 0.16 + strikePos * 0.18
      spineRoll = 0.14 * strikePos
    } else if (this.action === 'hook-left') {
      hipYaw = -strikeExtend * 0.34
      spineYaw = -strikeExtend * 0.62
      spinePitch = 0.16 + strikePos * 0.18
      spineRoll = -0.14 * strikePos
    } else if (this.action === 'uppercut-right' || this.action === 'combo-3') {
      hipYaw = strikeExtend * 0.28
      spineYaw = strikeExtend * 0.52
      spinePitch = THREE.MathUtils.lerp(0.28, -0.14, strikeSnap)
      spineRoll = -0.16 * strikePos
    } else if (this.action === 'uppercut-left') {
      hipYaw = -strikeExtend * 0.28
      spineYaw = -strikeExtend * 0.52
      spinePitch = THREE.MathUtils.lerp(0.28, -0.14, strikeSnap)
      spineRoll = 0.16 * strikePos
    } else if (this.action === 'chop-left' || this.action === 'combo-4') {
      hipYaw = -strikeExtend * 0.26
      spineYaw = -strikeExtend * 0.52
      spinePitch = 0.1 + strikePos * 0.26
    } else if (this.action === 'chop-right') {
      hipYaw = strikeExtend * 0.26
      spineYaw = strikeExtend * 0.52
      spinePitch = 0.1 + strikePos * 0.26
    } else if (this.action === 'punch-heavy') {
      hipYaw = strikeExtend * 0.32
      spineYaw = strikeExtend * 0.58
      spinePitch = 0.16 + strikePos * 0.28
    } else if (this.action === 'combo-5') {
      rootYaw = progress * Math.PI * 2
      spinePitch = -0.22 * snapArc
      lockHead = false
    } else if (
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick'
    ) {
      const kDir = this.action === 'kick-left' ? -1 : 1
      hipYaw = kDir * strikePos * 0.32
      spineYaw = kDir * strikePos * 0.35
      spinePitch = -0.26 * strikePos
      spineRoll = -kDir * 0.16 * strikePos
    } else if (this.action === 'palm-left' || this.action === 'palm-right') {
      const pDir = this.action === 'palm-left' ? -1 : 1
      hipYaw = pDir * strikePos * 0.16
      spineYaw = pDir * strikePos * 0.34
      spinePitch = 0.1 + strikePos * 0.14
    } else if (this.action === 'dodge-left' || this.action === 'dodge-right') {
      const dir = this.action === 'dodge-left' ? -1 : 1
      spineRoll = -dir * 0.32 * snapArc
      spineYaw = dir * 0.24 * snapArc
      spinePitch = 0.24 * snapArc
    } else if (this.action === 'crouch-dodge') {
      spinePitch = 0.42 * snapArc
      spineRoll = 0.08 * Math.sin(progress * Math.PI * 2)
    } else if (this.action === 'guard-parry') {
      spinePitch = -0.14 * strikePos
      spineYaw = 0.08 * strikePos
    } else if (this.action === 'grapple') {
      const tremor = Math.sin(elapsedTime * 36) * 0.035
      spinePitch = 0.36 + tremor
      spineYaw = Math.sin(elapsedTime * 19) * 0.07
    } else if (this.action === 'grapple-throw') {
      hipYaw = THREE.MathUtils.lerp(-0.35, 0.55, strikePos)
      spineYaw = THREE.MathUtils.lerp(-0.25, 0.55, strikePos)
      spinePitch = 0.24 - strikePos * 0.44
    } else if (this.action === 'backflip-land') {
      lockHead = false
      if (progress < 0.62) {
        const flipT = progress / 0.62
        extraFlipPitch = -flipT * Math.PI * 2 * this.sideSign
      } else {
        const recoverT = (progress - 0.62) / 0.38
        spinePitch = THREE.MathUtils.lerp(0.42, 0.06, recoverT)
        lockHead = true
      }
    } else if (this.action === 'cinematic-taunt') {
      spineYaw = Math.sin(progress * Math.PI) * 0.26
      spinePitch = -0.05
    } else if (this.action === 'beam-spread') {
      spinePitch = -0.16
    } else if (this.action === 'transform') {
      spinePitch = -0.06
      rootYaw = Math.PI - 0.16
      lockHead = false
    } else if (this.action === 'beam') {
      const p = Math.min(1, this.actionTime / 0.16)
      spinePitch = -0.06 * p
    } else if (this.action === 'hit-left') {
      spinePitch = -0.26 * snapArc
      spineYaw = -0.34 * snapArc
      spineRoll = 0.22 * snapArc
      lockHead = false
    } else if (this.action === 'hit-right') {
      spinePitch = -0.26 * snapArc
      spineYaw = 0.34 * snapArc
      spineRoll = -0.22 * snapArc
      lockHead = false
    } else if (this.action === 'hit-heavy') {
      spinePitch = -0.44 * snapArc
      spineRoll = 0.16 * Math.sin(progress * Math.PI * 2)
      lockHead = false
    } else if (this.action === 'hit') {
      spinePitch = -0.3 * snapArc
      lockHead = false
    } else if (this.action === 'disc') {
      const dDir = this.discChargeSide === 'left' ? -1 : 1
      hipYaw = dDir * strikePos * 0.18
      spineYaw = dDir * strikePos * 0.38
      spinePitch = 0.08 + strikePos * 0.16
    } else if (this.action === 'pose-intro') {
      spineYaw = -0.18 * snapArc
      spinePitch = -0.06 * snapArc
    } else {
      // 英雄性格微侧身（迪迦左前微侧，赛罗帅气半侧）
      if (this.profile.id === 'tiga') hipYaw = -0.12
      else if (this.profile.id === 'zero') hipYaw = 0.16
    }

    if (this.action === 'backflip-land' && progress < 0.62) {
      const pivotY = 6.75
      this.model.position.y = this.modelBaseY - pivotY
      this.root.position.set(
        this.currentX,
        this.combatVaultY + pivotY,
        this.sideSign * (this.baseZ - this.combatLungeZ),
      )
    } else {
      this.model.position.y = this.modelBaseY
      let procWorldZ = this.sideSign * (this.baseZ - this.combatLungeZ)
      if (this.sideSign === 1 && Number.isFinite(this.minSafeWorldZ)) {
        procWorldZ = Math.max(procWorldZ, this.minSafeWorldZ)
      }
      this.root.position.set(this.currentX, this.combatVaultY, procWorldZ)
    }

    this.root.rotation.set(
      extraFlipPitch,
      this.baseYaw + this.profile.facingYaw + rootYaw,
      0,
    )
    this.root.updateMatrixWorld(true)

    // 1. 下盘驱动（双脚实踏地面，踢腿/团身后空翻/弓步角力/深蹲各具形态）
    const isKicking =
      this.action === 'kick-left' ||
      this.action === 'kick-right' ||
      this.action === 'jump-kick' ||
      this.action === 'combo-5'
    const strideAmp = THREE.MathUtils.clamp(Math.abs(this.lateralSpeed) / 7.5, 0, 1)

    if (isKicking) {
      const p = strikePos
      const kickUpNorm = new THREE.Vector3(0, 0.9, -0.4)
      const supportNormL = new THREE.Vector3(-0.14, 0, -1)
      const supportNormR = new THREE.Vector3(0.14, 0, -1)

      if (this.action === 'kick-left') {
        this.aimBoneArena(
          b.thighL,
          new THREE.Vector3(-0.12, 0.44 * p - 0.88 * (1 - p), -0.96 * p - 0.16),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(
          b.shinL,
          new THREE.Vector3(-0.06, 0.38 * p - 0.94 * (1 - p), -0.98 * p + 0.12 * (1 - p)),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(b.thighR, new THREE.Vector3(0.14, -0.96, -0.04), 1, supportNormR)
        this.aimBoneArena(b.shinR, new THREE.Vector3(0.12, -0.96, 0.2), 1, supportNormR)
      } else {
        this.aimBoneArena(b.thighL, new THREE.Vector3(-0.14, -0.82, -0.42), 1, supportNormL)
        this.aimBoneArena(b.shinL, new THREE.Vector3(-0.1, -0.78, 0.56), 1, supportNormL)
        this.aimBoneArena(
          b.thighR,
          new THREE.Vector3(0.18, 0.5 * p - 0.85 * (1 - p), -0.96 * p - 0.12),
          1,
          kickUpNorm,
        )
        this.aimBoneArena(
          b.shinR,
          new THREE.Vector3(0.08, 0.46 * p - 0.92 * (1 - p), -0.98 * p + 0.14 * (1 - p)),
          1,
          kickUpNorm,
        )
      }
    } else if (this.action === 'backflip-land' && progress < 0.62) {
      // 真实空中团身抱膝翻腾！
      const tuck = Math.sin((progress / 0.62) * Math.PI)
      const normL = new THREE.Vector3(-0.12, 0.4, -0.9)
      const normR = new THREE.Vector3(0.12, 0.4, -0.9)
      this.aimBoneArena(b.thighL, new THREE.Vector3(-0.16, 0.35 * tuck - 0.5, -0.92), 1, normL)
      this.aimBoneArena(b.shinL, new THREE.Vector3(-0.12, -0.45, 0.88), 1, normL)
      this.aimBoneArena(b.thighR, new THREE.Vector3(0.16, 0.35 * tuck - 0.5, -0.92), 1, normR)
      this.aimBoneArena(b.shinR, new THREE.Vector3(0.12, -0.45, 0.88), 1, normR)
    } else if (this.action === 'backflip-land') {
      const kneeDepth = (1 - (progress - 0.62) / 0.38) * 0.72
      this.applyAthleticStanceLegs(kneeDepth, 0, 0)
      this.alignStandingFeetAndGround(0)
    } else if (this.action === 'grapple') {
      const normL = new THREE.Vector3(-0.12, 0, -1)
      const normR = new THREE.Vector3(0.14, 0, -1)
      this.aimBoneArena(b.thighL, new THREE.Vector3(-0.18, -0.64, -0.74), 1, normL)
      this.aimBoneArena(b.shinL, new THREE.Vector3(-0.14, -0.96, 0.18), 1, normL)
      this.aimBoneArena(b.thighR, new THREE.Vector3(0.2, -0.78, 0.58), 1, normR)
      this.aimBoneArena(b.shinR, new THREE.Vector3(0.16, -0.64, 0.75), 1, normR)
      this.alignStandingFeetAndGround(0)
    } else if (this.action === 'crouch-dodge') {
      this.applyAthleticStanceLegs(0.74 * snapArc, 0, 0)
      this.alignStandingFeetAndGround(0)
    } else if (this.action === 'transform') {
      const frontNormL = new THREE.Vector3(0.12, 0, 1)
      const frontNormR = new THREE.Vector3(-0.14, 0, 1)
      this.aimBoneArena(b.thighL, new THREE.Vector3(0.12, -0.97, 0.14), 1, frontNormL)
      this.aimBoneArena(b.shinL, new THREE.Vector3(0.1, -0.98, -0.1), 1, frontNormL)
      this.aimBoneArena(b.thighR, new THREE.Vector3(-0.14, -0.97, 0.08), 1, frontNormR)
      this.aimBoneArena(b.shinR, new THREE.Vector3(-0.12, -0.98, -0.12), 1, frontNormR)
      this.alignStandingFeetAndGround(0)
    } else if (this.action === 'dodge-left' || this.action === 'dodge-right') {
      this.applyAthleticStanceLegs(0.36 * snapArc, 0.22 * snapArc, 0.85)
      this.alignStandingFeetAndGround(this.combatVaultY)
    } else {
      const strikeFlex =
        this.action.startsWith('combo-') ||
        this.action.startsWith('punch-') ||
        this.action.startsWith('hook-') ||
        this.action.startsWith('uppercut-') ||
        this.action.startsWith('chop-')
          ? 0.24 * strikePos + 0.08
          : 0.08 + breath * 0.02
      this.applyAthleticStanceLegs(strikeFlex, this.combatVaultY > 0.4 ? 0.22 : 0, strideAmp)
      this.alignStandingFeetAndGround(this.combatVaultY)
    }

    // 2. 骨盆 + 多节脊柱分级扭转（真实动力链核心） + 头部视线死锁目标
    if (b.hip && Math.abs(hipYaw) > 1e-4) {
      this.applyArenaEulerDelta(b.hip, hipYaw, 0, 0)
    }
    this.driveSpineChain(spineYaw, spinePitch, spineRoll)
    if (lockHead) {
      this.driveHeadLookLock(hipYaw + spineYaw, spinePitch, spineRoll, 0.85)
    }
    this.root.updateMatrixWorld(true)

    // 3. 上肢全链条驱动（全部经由 driveArenaArmChain，保证锁骨联动 + 大臂肘背法线防拧）
    const guardPalmL = new THREE.Vector3(0.7, -0.55, 0.45)
    const guardPalmR = new THREE.Vector3(-0.7, -0.55, 0.45)
    const punchPalmDown = new THREE.Vector3(0, -1, 0.15)

    if (this.action === 'transform') {
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(-0.16, 0.96, 0.22),
        new THREE.Vector3(-0.06, 0.99, 0.12),
        new THREE.Vector3(0.9, 0, -0.35),
        0.95,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(0.46, -0.62, 0.56),
        new THREE.Vector3(-0.18, 0.18, 0.94),
        new THREE.Vector3(-0.7, -0.55, -0.45),
        0.9,
      )
    } else if (this.action === 'beam-spread') {
      const pulse = Math.sin(elapsedTime * 16) * 0.05
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.96, 0.14 + pulse, -0.2),
        new THREE.Vector3(-0.98, 0.18 + pulse, -0.14),
        new THREE.Vector3(0, 0.35, -0.92),
        0,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.96, 0.14 + pulse, -0.2),
        new THREE.Vector3(0.98, 0.18 + pulse, -0.14),
        new THREE.Vector3(0, 0.35, -0.92),
        0,
      )
    } else if (this.action === 'beam' || this.beamChargeVisual > 0.08) {
      const isLeftMain = this.beamArmSide === 'left'
      const sx = isLeftMain ? -1 : 1
      this.driveArenaArmChain(
        isLeftMain ? 'L' : 'R',
        new THREE.Vector3(sx * 0.24, -0.18, -0.95),
        new THREE.Vector3(-sx * 0.04, 0.99, -0.1),
        new THREE.Vector3(-sx * 0.95, 0, 0.3),
        0,
      )
      this.driveArenaArmChain(
        isLeftMain ? 'R' : 'L',
        new THREE.Vector3(-sx * 0.34, -0.26, -0.9),
        new THREE.Vector3(sx * 0.96, 0.05, -0.24),
        new THREE.Vector3(0, 0.15, 0.98),
        0,
      )
    } else if (this.action === 'grapple') {
      const push = Math.sin(elapsedTime * 28) * 0.06
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.26, 0.18 + push, -0.94),
        new THREE.Vector3(-0.1, 0.06, -0.99),
        guardPalmL,
        0.3,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.26, 0.18 - push, -0.94),
        new THREE.Vector3(0.1, 0.06, -0.99),
        guardPalmR,
        0.3,
      )
    } else if (this.action === 'grapple-throw') {
      const p = strikePos
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.42 + p * 0.5, 0.65 * p + 0.1, -0.82),
        new THREE.Vector3(-0.2 + p * 0.55, 0.8 * p, -0.78),
        guardPalmL,
        0.85,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.42 + p * 0.3, 0.72 * p + 0.1, -0.75),
        new THREE.Vector3(0.28 + p * 0.4, 0.85 * p, -0.72),
        guardPalmR,
        0.85,
      )
    } else if (this.action === 'guard-parry') {
      // 完美弹反：双臂由胸前交叉猛烈向外震开，震飞敌招！
      const p = strikePos
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(THREE.MathUtils.lerp(-0.25, -0.88, p), THREE.MathUtils.lerp(-0.1, 0.25, p), THREE.MathUtils.lerp(-0.95, -0.45, p)),
        new THREE.Vector3(THREE.MathUtils.lerp(0.55, -0.75, p), THREE.MathUtils.lerp(0.78, 0.52, p), -0.45),
        new THREE.Vector3(0.2, -0.2, -0.95),
        0.1,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(THREE.MathUtils.lerp(0.25, 0.88, p), THREE.MathUtils.lerp(-0.1, 0.25, p), THREE.MathUtils.lerp(-0.95, -0.45, p)),
        new THREE.Vector3(THREE.MathUtils.lerp(-0.55, 0.75, p), THREE.MathUtils.lerp(0.78, 0.52, p), -0.45),
        new THREE.Vector3(-0.2, -0.2, -0.95),
        0.1,
      )
    } else if (this.action === 'cinematic-taunt') {
      const wipe = Math.sin(progress * Math.PI)
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.38, 0.24 * wipe - 0.1, -0.88),
        new THREE.Vector3(-0.62 * wipe, 0.72, -0.42),
        new THREE.Vector3(0, 0.2, 0.95),
        0.3,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.46, -0.45, -0.74),
        new THREE.Vector3(0.26, 0.38, -0.88),
        guardPalmL,
        0.9,
      )
    } else if (this.isGuarding) {
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.26, -0.1, -0.95),
        new THREE.Vector3(0.56, 0.8, -0.2),
        new THREE.Vector3(0.3, -0.1, 0.95),
        0.25,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.26, -0.1, -0.95),
        new THREE.Vector3(-0.56, 0.8, -0.2),
        new THREE.Vector3(-0.3, -0.1, 0.95),
        0.25,
      )
    } else if (
      this.action === 'combo-1' ||
      this.action === 'punch-right' ||
      this.action === 'punch-heavy'
    ) {
      const p = strikePos
      const lift = this.action === 'punch-heavy' ? 0.3 : 0.16
      // 蓄力段右臂微收肩，爆发段直线轰出，左臂收颌护胸
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.22 * (1 - p), lift * p - 0.14 * (1 - p), THREE.MathUtils.lerp(-0.42, -0.99, Math.max(0, strikeExtend * 0.5 + 0.5))),
        new THREE.Vector3(-0.08 * p, lift * p + 0.06, -0.99),
        punchPalmDown,
        1,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.58, -0.44, -0.45),
        new THREE.Vector3(0.36, 0.44, -0.8),
        guardPalmL,
        1,
      )
    } else if (this.action === 'punch-left') {
      const p = strikePos
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.22 * (1 - p), 0.16 * p - 0.14 * (1 - p), THREE.MathUtils.lerp(-0.42, -0.99, Math.max(0, strikeExtend * 0.5 + 0.5))),
        new THREE.Vector3(0.08 * p, 0.16 * p + 0.06, -0.99),
        punchPalmDown,
        1,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.58, -0.44, -0.45),
        new THREE.Vector3(-0.36, 0.44, -0.8),
        guardPalmR,
        1,
      )
    } else if (this.action === 'hook-left' || this.action === 'combo-2') {
      const sweepX = THREE.MathUtils.lerp(-0.92, 0.38, strikeSnap)
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(sweepX * 0.68, 0.14 * strikePos, -0.82),
        new THREE.Vector3(sweepX + 0.36, 0.18 * strikePos, -0.86),
        punchPalmDown,
        1,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.6, -0.46, -0.36),
        new THREE.Vector3(-0.32, 0.38, -0.82),
        guardPalmR,
        1,
      )
    } else if (this.action === 'hook-right') {
      const sweepX = THREE.MathUtils.lerp(0.92, -0.38, strikeSnap)
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(sweepX * 0.68, 0.14 * strikePos, -0.82),
        new THREE.Vector3(sweepX - 0.36, 0.18 * strikePos, -0.86),
        punchPalmDown,
        1,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.6, -0.46, -0.36),
        new THREE.Vector3(0.32, 0.38, -0.82),
        guardPalmL,
        1,
      )
    } else if (this.action === 'uppercut-right' || this.action === 'combo-3') {
      const p = strikeSnap
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.24, THREE.MathUtils.lerp(-0.68, 0.56, p), -0.78),
        new THREE.Vector3(-0.18, THREE.MathUtils.lerp(-0.22, 0.9, p), -0.7),
        new THREE.Vector3(-0.4, 0.2, 0.88),
        1,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.6, -0.5, -0.38),
        new THREE.Vector3(0.34, 0.32, -0.84),
        guardPalmL,
        1,
      )
    } else if (this.action === 'uppercut-left') {
      const p = strikeSnap
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.24, THREE.MathUtils.lerp(-0.68, 0.56, p), -0.78),
        new THREE.Vector3(0.18, THREE.MathUtils.lerp(-0.22, 0.9, p), -0.7),
        new THREE.Vector3(0.4, 0.2, 0.88),
        1,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.6, -0.5, -0.38),
        new THREE.Vector3(-0.34, 0.32, -0.84),
        guardPalmR,
        1,
      )
    } else if (this.action === 'chop-left' || this.action === 'combo-4') {
      const p = strikeSnap
      const chopY = THREE.MathUtils.lerp(0.88, -0.36, p)
      const chopX = THREE.MathUtils.lerp(-0.56, 0.42, p)
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(chopX * 0.7, chopY, -0.82),
        new THREE.Vector3(chopX, chopY - 0.12, -0.9),
        new THREE.Vector3(0.85, -0.35, 0.2),
        0,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.58, -0.45, -0.45),
        new THREE.Vector3(-0.26, 0.34, -0.86),
        guardPalmR,
        0.95,
      )
    } else if (this.action === 'chop-right') {
      const p = strikeSnap
      const chopY = THREE.MathUtils.lerp(0.88, -0.36, p)
      const chopX = THREE.MathUtils.lerp(0.56, -0.42, p)
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(chopX * 0.7, chopY, -0.82),
        new THREE.Vector3(chopX, chopY - 0.12, -0.9),
        new THREE.Vector3(-0.85, -0.35, 0.2),
        0,
      )
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.58, -0.45, -0.45),
        new THREE.Vector3(0.26, 0.34, -0.86),
        guardPalmL,
        0.95,
      )
    } else if (this.action === 'palm-left' || this.action === 'palm-right') {
      const isLeft = this.action === 'palm-left'
      const p = strikePos
      if (isLeft) {
        this.driveArenaArmChain(
          'L',
          new THREE.Vector3(-0.16, 0.14 * p, -0.97),
          new THREE.Vector3(0.06, 0.18 * p, -0.99),
          new THREE.Vector3(0.2, -0.85, -0.4),
          0,
        )
        this.driveArenaArmChain(
          'R',
          new THREE.Vector3(0.54, -0.44, -0.58),
          new THREE.Vector3(-0.24, 0.32, -0.88),
          guardPalmR,
          0.85,
        )
      } else {
        this.driveArenaArmChain(
          'R',
          new THREE.Vector3(0.16, 0.14 * p, -0.97),
          new THREE.Vector3(-0.06, 0.18 * p, -0.99),
          new THREE.Vector3(-0.2, -0.85, -0.4),
          0,
        )
        this.driveArenaArmChain(
          'L',
          new THREE.Vector3(-0.54, -0.44, -0.58),
          new THREE.Vector3(0.24, 0.32, -0.88),
          guardPalmL,
          0.85,
        )
      }
    } else if (this.action === 'dodge-left' || this.action === 'dodge-right') {
      const dir = this.action === 'dodge-left' ? -1 : 1
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.6 - dir * 0.18, -0.2, -0.68),
        new THREE.Vector3(0.24, 0.48, -0.82),
        guardPalmL,
        0.85,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.6 - dir * 0.18, -0.2, -0.68),
        new THREE.Vector3(-0.24, 0.48, -0.82),
        guardPalmR,
        0.85,
      )
    } else if (this.action === 'crouch-dodge') {
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.52, -0.22, -0.82),
        new THREE.Vector3(0.32, 0.56, -0.76),
        guardPalmL,
        0.85,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.52, -0.22, -0.82),
        new THREE.Vector3(-0.32, 0.56, -0.76),
        guardPalmR,
        0.85,
      )
    } else if (this.action === 'backflip-land' && progress < 0.62) {
      // 空中团身双臂收护胸侧
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.42, -0.1, -0.88),
        new THREE.Vector3(0.24, 0.64, -0.72),
        guardPalmL,
        0.92,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(0.42, -0.1, -0.88),
        new THREE.Vector3(-0.24, 0.64, -0.72),
        guardPalmR,
        0.92,
      )
    } else if (this.action === 'disc' || this.discChargeVisual > 0.08) {
      const isLeft = this.discChargeSide === 'left'
      const activeSide: 'L' | 'R' = isLeft ? 'L' : 'R'
      const idleSide: 'L' | 'R' = isLeft ? 'R' : 'L'
      const sx = isLeft ? -1 : 1
      if (this.action === 'disc') {
        const swingY = THREE.MathUtils.lerp(0.86, -0.26, strikeSnap)
        this.driveArenaArmChain(
          activeSide,
          new THREE.Vector3(sx * 0.28, swingY, -0.92),
          new THREE.Vector3(sx * 0.12, swingY - 0.1, -0.98),
          new THREE.Vector3(-sx * 0.9, -0.3, 0.2),
          0,
        )
      } else {
        this.driveArenaArmChain(
          activeSide,
          new THREE.Vector3(sx * 0.35, 0.92, -0.18),
          new THREE.Vector3(sx * 0.12, 0.98, -0.15),
          new THREE.Vector3(-sx * 0.95, 0, 0.25),
          0,
        )
      }
      this.driveArenaArmChain(
        idleSide,
        new THREE.Vector3(-sx * 0.46, -0.52, -0.62),
        new THREE.Vector3(sx * 0.25, 0.3, -0.92),
        isLeft ? guardPalmR : guardPalmL,
        0.92,
      )
    } else if (this.action === 'pose-intro') {
      const p = snapArc
      if (this.profile.id === 'zero') {
        // 赛罗开场招牌擦鼻挑衅
        this.driveArenaArmChain(
          'R',
          new THREE.Vector3(0.36, 0.26 * p - 0.15, -0.86),
          new THREE.Vector3(-0.56 * p, 0.72, -0.45),
          new THREE.Vector3(0, 0.2, 0.95),
          0.25,
        )
      } else {
        this.driveArenaArmChain(
          'R',
          new THREE.Vector3(0.32, 0.48 * p - 0.3 * (1 - p), -0.82),
          new THREE.Vector3(-0.18, 0.85 * p + 0.24 * (1 - p), -0.55),
          guardPalmR,
          0.95,
        )
      }
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-0.5, -0.28, -0.75),
        new THREE.Vector3(0.26, 0.52, -0.8),
        guardPalmL,
        this.profile.id === 'tiga' ? 0.15 : 0.88,
      )
    } else if (
      this.action === 'hit' ||
      this.action === 'hit-left' ||
      this.action === 'hit-right' ||
      this.action === 'hit-heavy'
    ) {
      const spread = this.action === 'hit-heavy' ? 0.86 : 0.72
      this.driveArenaArmChain(
        'L',
        new THREE.Vector3(-spread, -0.18, -0.42),
        new THREE.Vector3(-0.45, 0.46, -0.66),
        guardPalmL,
        0.45,
      )
      this.driveArenaArmChain(
        'R',
        new THREE.Vector3(spread, -0.18, -0.42),
        new THREE.Vector3(0.45, 0.46, -0.66),
        guardPalmR,
        0.45,
      )
    } else {
      this.applyHeroIdleArms(breath)
    }

    this.root.updateMatrixWorld(true)
  }
}
