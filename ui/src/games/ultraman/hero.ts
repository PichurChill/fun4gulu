import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { FingerChain, HeroFormSpec, HeroProfile } from './heroes'
import type { HeroAction, LiveBodyPose, Vec3Like } from './types'

const tmpV1 = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpQ1 = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()

function lerpVec(target: THREE.Vector3, src: Vec3Like, alpha: number) {
  tmpV1.set(src.x, src.y, src.z)
  if (tmpV1.lengthSq() < 1e-6) return
  tmpV1.normalize()
  target.lerp(tmpV1, alpha)
  if (target.lengthSq() > 1e-6) target.normalize()
}

/**
 * 奥特曼第三人称全身骨骼控制器（迪迦 / 赛罗通用）
 * 支持两种无缝衔接的驱动模式：
 * 1) 体感实时全身动捕重定向（头、脊柱、双臂、双手、双腿、下蹲/跳跃 1:1 实时同步玩家）
 * 2) 键盘/触屏程序化经典招式动画（出拳、飞踢、交叉防御、光轮、光线、胜利升空）
 *
 * 骨骼绑定优化：通过 HeroProfile 的逻辑骨名映射驱动任意命名的骨架；
 * 骨骼指向尾端优先读取模型自带 bone_tips 元数据，缺失时自动用子骨世界位置推导；
 * 手指弯曲基于世界系掌心法线逐节累计旋转，不再依赖任何骨架局部轴约定。
 */
export class HeroController {
  public readonly root = new THREE.Group()
  private model: THREE.Object3D | null = null
  private profile: HeroProfile | null = null
  private loadGen = 0
  /** 模型内全部骨骼（按模型真实骨名索引） */
  private bones = new Map<string, THREE.Bone>()
  /** 逻辑骨（upperArmL / spineLower / ...）-> 实际骨骼 */
  private logical = new Map<string, THREE.Bone>()
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private restPositions = new Map<THREE.Bone, THREE.Vector3>()
  private boneTips = new Map<THREE.Bone, THREE.Vector3>()
  private timerMaterials: THREE.MeshStandardMaterial[] = []
  private eyeMaterials: THREE.MeshStandardMaterial[] = []
  /** 形态染色目标：银色身体 / 形态纹路（如迪迦 Multi-Type 紫）两组材质 */
  private formSilverMaterials: THREE.MeshStandardMaterial[] = []
  private formMultiMaterials: THREE.MeshStandardMaterial[] = []
  private currentForm: HeroFormSpec | null = null
  /** 静止站立时脚踝骨距地面的初始高度，用于动捕时自动脚底贴地校正 */
  private restAnkleY = 0.85

  public readonly baseZ = 20
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

  // 实时体感全身平滑状态
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
  private smUpperL = new THREE.Vector3(-0.45, -0.35, -0.78).normalize()
  private smLowerL = new THREE.Vector3(0.22, 0.42, -0.88).normalize()
  private smHandL = new THREE.Vector3(0.22, 0.42, -0.88).normalize()
  private smUpperR = new THREE.Vector3(0.55, -0.52, -0.62).normalize()
  private smLowerR = new THREE.Vector3(-0.18, 0.24, -0.95).normalize()
  private smHandR = new THREE.Vector3(-0.18, 0.24, -0.95).normalize()
  private smThighL = new THREE.Vector3(-0.14, -0.96, -0.22).normalize()
  private smShinL = new THREE.Vector3(-0.08, -0.98, 0.16).normalize()
  private smThighR = new THREE.Vector3(0.16, -0.96, -0.12).normalize()
  private smShinR = new THREE.Vector3(0.08, -0.98, 0.14).normalize()

  constructor(scene: THREE.Scene) {
    this.root.name = 'UltraHeroRoot'
    this.root.position.set(0, 0, this.baseZ)
    // 默认朝向修正由 profile.facingYaw 提供，root 绕 Y 旋转后背对镜头、面朝前方 -Z 的怪兽
    this.root.rotation.set(0, Math.PI, 0)
    scene.add(this.root)
  }

  public async load(loader: GLTFLoader, profile: HeroProfile): Promise<void> {
    if (this.profile?.id === profile.id && this.model) return
    // 加载代际号：快速连续切换英雄时，只让最后一次加载生效
    const gen = ++this.loadGen
    const gltf = await loader.loadAsync(profile.modelUrl)
    if (gen !== this.loadGen) return
    this.unloadModel()
    this.profile = profile
    const model = gltf.scene
    this.model = model

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
    this.formSilverMaterials = []
    this.formMultiMaterials = []
    this.currentForm = null
    let fallbackGlowMaterial: THREE.MeshStandardMaterial | null = null

    model.traverse((node) => {
      if ((node as THREE.Bone).isBone) {
        const bone = node as THREE.Bone
        this.bones.set(bone.name, bone)
        this.restQuats.set(bone, bone.quaternion.clone())
        this.restPositions.set(bone, bone.position.clone())
      }
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial) {
            const matches = (names: string[]) =>
              names.some((n) => m.name.includes(n) || mesh.name.includes(n))
            if (profile.formBodyMaterials && matches(profile.formBodyMaterials.silver)) {
              this.formSilverMaterials.push(m)
            } else if (profile.formBodyMaterials && matches(profile.formBodyMaterials.multiType)) {
              this.formMultiMaterials.push(m)
            } else if (profile.timerMaterialNames.length > 0 && matches(profile.timerMaterialNames)) {
              if (!mesh.name.includes('Container')) {
                this.timerMaterials.push(m)
                m.emissive = new THREE.Color(profile.accentColor)
                m.emissiveIntensity = profile.timerIdleIntensity
              }
            } else if (profile.eyeMaterialNames.length > 0 && matches(profile.eyeMaterialNames)) {
              this.eyeMaterials.push(m)
              m.emissive = new THREE.Color(0xfff4c2)
              m.emissiveIntensity = 1.8
            } else {
              m.roughness = Math.min(m.roughness, 0.52)
              m.metalness = Math.max(m.metalness, 0.18)
              if (!fallbackGlowMaterial) fallbackGlowMaterial = m
            }
          }
        }
      }
    })

    // 重建被导出器拍平的肢体骨骼链（attach 保持世界姿势不变，仅恢复旋转传播路径），
    // 并同步更新受影响骨骼的静息记录
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

    // 单材质模型（如赛罗）：没有独立计时器材质，用首个身体材质承载危险能量脉冲
    if (this.timerMaterials.length === 0 && fallbackGlowMaterial) {
      this.timerMaterials.push(fallbackGlowMaterial)
    }

    // 逻辑骨名解析
    this.logical.clear()
    for (const [key, actualName] of Object.entries(profile.bones)) {
      if (!actualName || key === 'fingersL' || key === 'fingersR') continue
      const bone = this.bones.get(actualName)
      if (bone) this.logical.set(key, bone)
    }

    // fail-fast：关键驱动骨或手指链缺失时立即暴露，绝不带着残缺绑定静默运行
    const requiredLimbs = [
      'upperArmL', 'lowerArmL', 'handL',
      'upperArmR', 'lowerArmR', 'handR',
      'thighL', 'shinL', 'footL',
      'thighR', 'shinR', 'footR',
      'head', 'spineLower', 'spineChest',
    ] as const
    const missing = requiredLimbs.filter((key) => !this.logical.has(key))
    if (missing.length > 0) {
      throw new Error(
        `[HeroRig] ${profile.id} 模型缺少关键骨骼映射: ${missing.join(', ')}；` +
          `请核对 heroes.ts 骨名与 GLB 加载后的实际骨骼名（three.js 会把骨名中的空白规范化为下划线）`,
      )
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

    // 骨骼指向尾端：优先读取模型自带 bone_tips 元数据（迪迦），
    // 缺失的骨骼自动用全部子骨的世界位置均值推导（赛罗 Bip001 等）
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

    // 记录静止脚踝高度，用于动捕踢腿/扎马步时保持支撑脚贴地
    const footL = this.logical.get('footL')
    const footR = this.logical.get('footR')
    if (footL && footR) {
      this.root.updateMatrixWorld(true)
      this.restAnkleY = Math.min(
        footL.getWorldPosition(new THREE.Vector3()).y,
        footR.getWorldPosition(new THREE.Vector3()).y,
      )
    }
  }

  private unloadModel() {
    if (!this.model) return
    this.root.remove(this.model)
    this.model.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        mesh.geometry.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) m.dispose()
      }
    })
    this.model = null
    this.bones.clear()
    this.logical.clear()
    this.restQuats.clear()
    this.restPositions.clear()
    this.boneTips.clear()
    this.timerMaterials = []
    this.eyeMaterials = []
    this.formSilverMaterials = []
    this.formMultiMaterials = []
    this.currentForm = null
  }

  public setLean(lean: number) {
    this.targetX = THREE.MathUtils.clamp(lean, -1, 1) * 5.6 * (this.currentForm?.moveMul ?? 1)
  }

  /** 切换形态：身体材质染色 + 移动速度倍率（无形态英雄传 null 还原默认） */
  public setForm(form: HeroFormSpec | null) {
    this.currentForm = form
    if (!form) {
      for (const m of this.formSilverMaterials) m.color.setRGB(1, 1, 1)
      for (const m of this.formMultiMaterials) m.color.setRGB(1, 1, 1)
      return
    }
    for (const m of this.formSilverMaterials) m.color.setRGB(...form.bodyTints.silver)
    for (const m of this.formMultiMaterials) m.color.setRGB(...form.bodyTints.multiType)
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

  /** 输入实时摄像头动捕全身骨骼数据（每帧无缝跟随玩家） */
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
    this.root.position.set(0, 0, this.baseZ)
    this.root.rotation.set(0, Math.PI + (this.profile?.facingYaw ?? 0), 0)
  }

  public getAction(): HeroAction {
    return this.action
  }

  /** 将指定骨骼指向给定的世界方向向量 */
  private aimBone(boneName: string, worldDir: THREE.Vector3, weight = 1) {
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

  /** 获取骨骼当前世界指向（origin -> 尾端），无尾端信息时返回 null */
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

  /**
   * 弯曲单手全部手指（0=完全伸直手刀，1=紧握拳头）
   * 世界系通用实现：掌心法线 = 手刀方向 × 食指根→小指根，
   * 各指节绕“手刀方向 × 掌心法线”轴按累计角弯向掌心，与骨架命名和局部轴无关
   */
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
      // 先记录各指节本帧静息指向，再按累计弯曲角逐节弯向掌心（子节自动叠加父节旋转）
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
        this.aimBone(chain[j]!, dir)
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
    return this.root.position.clone().add(fallbackOffset)
  }

  /** 获取当前发射光线的前臂上下两点（自动跟随玩家竖直的那侧手臂） */
  public getBeamOriginSegment(): [THREE.Vector3, THREE.Vector3] {
    const suffix = this.beamArmSide === 'left' ? 'L' : 'R'
    const sx = this.beamArmSide === 'left' ? -0.6 : 0.6
    const elbow = this.getBoneWorldPosition(`lowerArm${suffix}`, new THREE.Vector3(sx, 8.8, -1.8))
    const wrist = this.getBoneWorldPosition(`hand${suffix}`, new THREE.Vector3(sx, 10.6, -1.8))
    elbow.z -= 0.45
    wrist.z -= 0.45
    return [elbow, wrist]
  }

  /** 获取光轮发射点（严格跟随真实举起的手掌） */
  public getDiscOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(
      `hand${suffix}`,
      new THREE.Vector3(side === 'left' ? -2 : 2, 13.5, -1),
    )
    p.y += 1.15
    return p
  }

  /** 获取出拳击打点（严格跟随真实拳头位置） */
  public getFistOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    return this.getBoneWorldPosition(
      `hand${suffix}`,
      new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 10, -2.5),
    )
  }

  /** 获取奥特飞踢脚尖发射点 */
  public getFootOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(
      `foot${suffix}`,
      new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 5.5, -2.2),
    )
    p.z -= 0.6
    return p
  }

  public update(dt: number, elapsedTime: number, dangerTimer: boolean, nowMs = performance.now()) {
    if (!this.model) return

    if (this.action !== 'idle' && this.action !== 'victory') {
      this.actionTime += dt
      if (this.actionTime >= this.actionDuration) {
        this.action = 'idle'
        this.actionTime = 0
      }
    }

    // 重置骨骼至静息姿态
    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }
    for (const [bone, pos] of this.restPositions) {
      bone.position.copy(pos)
    }

    // 左右闪避平滑移动
    this.currentX += (this.targetX - this.currentX) * Math.min(1, dt * 12)

    // 彩色计时器与双眼辉光
    const idleIntensity = this.profile?.timerIdleIntensity ?? 1.2
    for (const m of this.timerMaterials) {
      if (dangerTimer) {
        const blink = Math.sin(elapsedTime * 11.5) > 0
        m.emissive.setHex(blink ? 0xff1f3d : 0x550011)
        m.emissiveIntensity = blink ? 3.2 : 0.4
      } else {
        m.emissiveIntensity = idleIntensity + Math.sin(elapsedTime * 3.5) * 0.25
      }
    }
    for (const m of this.eyeMaterials) {
      m.emissiveIntensity = 1.7 + Math.sin(elapsedTime * 2.5) * 0.2
    }

    // 胜利升空特殊动画
    if (this.action === 'victory') {
      this.updateVictoryAscent(dt)
      return
    }

    // 优先使用摄像头全身实时动捕姿态：奥特曼整体一举一动完全跟随识别到的真人！
    if (this.isLiveTracking(nowMs) && this.livePose) {
      this.applyLiveBodyPose(this.livePose, dt, elapsedTime)
      return
    }

    // 键盘 / 触屏模式：程序化经典特摄动画
    this.applyProceduralPose(elapsedTime)
  }

  private updateVictoryAscent(dt: number) {
    this.victoryAscent += dt
    const t = Math.min(1, this.victoryAscent / 2.2)
    const easeUp = t * t
    this.root.position.set(this.currentX * (1 - t), easeUp * 26, this.baseZ - easeUp * 14)
    this.root.rotation.set(
      easeUp * 0.28,
      Math.PI + (this.profile?.facingYaw ?? 0) + Math.sin(this.victoryAscent * 1.4) * 0.2,
      0,
    )
    this.root.updateMatrixWorld(true)
    this.aimBone(this.profile!.bones.upperArmR, new THREE.Vector3(0.08, 0.96, -0.25))
    this.aimBone(this.profile!.bones.lowerArmR, new THREE.Vector3(0.04, 0.98, -0.2))
    this.aimBone(this.profile!.bones.upperArmL, new THREE.Vector3(-0.22, -0.92, 0.3))
    this.aimBone(this.profile!.bones.lowerArmL, new THREE.Vector3(-0.15, -0.95, 0.28))
    this.curlHand('R', 1)
    this.curlHand('L', 1)
    this.root.updateMatrixWorld(true)
  }

  /**
   * 实时全身动捕驱动：平滑映射头、脊柱、双臂、双手、双腿、下蹲与起跳
   * 体感优化：动态速率平滑——肢体方向突变（快速出拳/挥臂/踢腿）时瞬时拉高跟随速率，
   * 小幅摄像头噪声仍走强防抖基线，快动作跟手与静止防抖两不误
   */
  private applyLiveBodyPose(pose: LiveBodyPose, dt: number, elapsedTime: number) {
    const baseRate = 20
    const alpha = 1 - Math.exp(-dt * baseRate)
    const adaptiveAlpha = (cur: THREE.Vector3, target: Vec3Like | null, fallback: number) => {
      if (!target) return fallback
      tmpV1.set(target.x, target.y, target.z).normalize()
      if (tmpV1.lengthSq() < 1e-6) return fallback
      const change = 1 - Math.min(1, Math.max(-1, cur.dot(tmpV1)))
      const rate = baseRate + Math.min(70, Math.max(0, change - 0.0015) * 1500)
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

    if (pose.upperArmL) lerpVec(this.smUpperL, pose.upperArmL, adaptiveAlpha(this.smUpperL, pose.upperArmL, alpha))
    if (pose.lowerArmL) lerpVec(this.smLowerL, pose.lowerArmL, adaptiveAlpha(this.smLowerL, pose.lowerArmL, alpha))
    if (pose.handL) lerpVec(this.smHandL, pose.handL, adaptiveAlpha(this.smHandL, pose.handL, alpha))
    else if (pose.lowerArmL) lerpVec(this.smHandL, pose.lowerArmL, alpha)

    if (pose.upperArmR) lerpVec(this.smUpperR, pose.upperArmR, adaptiveAlpha(this.smUpperR, pose.upperArmR, alpha))
    if (pose.lowerArmR) lerpVec(this.smLowerR, pose.lowerArmR, adaptiveAlpha(this.smLowerR, pose.lowerArmR, alpha))
    if (pose.handR) lerpVec(this.smHandR, pose.handR, adaptiveAlpha(this.smHandR, pose.handR, alpha))
    else if (pose.lowerArmR) lerpVec(this.smHandR, pose.lowerArmR, alpha)

    if (pose.thighL) lerpVec(this.smThighL, pose.thighL, adaptiveAlpha(this.smThighL, pose.thighL, alpha))
    if (pose.shinL) lerpVec(this.smShinL, pose.shinL, adaptiveAlpha(this.smShinL, pose.shinL, alpha))
    if (pose.thighR) lerpVec(this.smThighR, pose.thighR, adaptiveAlpha(this.smThighR, pose.thighR, alpha))
    if (pose.shinR) lerpVec(this.smShinR, pose.shinR, adaptiveAlpha(this.smShinR, pose.shinR, alpha))

    // 受击轻微后撤震动（叠加在真人姿态上，不覆盖四肢）
    let hitBackZ = 0
    let hitPitch = 0
    if (this.action === 'hit') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      hitBackZ = 1.4 * p
      hitPitch = -0.18 * p
    }

    this.root.position.set(this.currentX, this.smJumpHeight, this.baseZ + hitBackZ)
    // 根节点朝向面朝 -Z，并叠加玩家真实的扭腰转肩水平角
    this.root.rotation.set(0, Math.PI + (this.profile?.facingYaw ?? 0) + this.smTorsoYaw * 0.45, 0)
    this.root.updateMatrixWorld(true)

    // 1. 脊柱分段弯曲（俯仰 + 侧倾 + 扭腰，流畅自然）
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

    // 2. 头部跟随玩家转头、抬头/低头与歪头
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

    // 3. 双腿驱动：全身入镜时直接 1:1 跟随双腿（支持抬腿飞踢、扎马步、劈叉等）；
    //    半身入镜时用带下蹲屈膝与起跳收腿的稳健战斗弓步承接上半身
    const hip = this.logical.get('hip')
    if (pose.coverage === 'full' && pose.thighL && pose.thighR && this.profile) {
      this.aimBone(this.profile.bones.thighL, this.smThighL)
      if (pose.shinL) this.aimBone(this.profile.bones.shinL, this.smShinL)
      this.aimBone(this.profile.bones.thighR, this.smThighR)
      if (pose.shinR) this.aimBone(this.profile.bones.shinR, this.smShinR)

      // 自动支撑脚贴地校正：计算当前左右脚踝世界最低点，贴齐地面再叠加跳跃高度
      this.root.updateMatrixWorld(true)
      const footL = this.logical.get('footL')
      const footR = this.logical.get('footR')
      if (footL && footR) {
        const minFootY = Math.min(
          footL.getWorldPosition(tmpV1).y,
          footR.getWorldPosition(tmpV2).y,
        )
        const groundDelta = this.restAnkleY - minFootY
        this.root.position.y = Math.max(0, this.root.position.y + groundDelta) + this.smJumpHeight
      }
    } else {
      const crouchFlex = THREE.MathUtils.clamp(this.smCrouchDepth * 0.28, 0, 0.72)
      const jumpTuck = THREE.MathUtils.clamp(this.smJumpHeight * 0.14, 0, 0.55)
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

    this.root.updateMatrixWorld(true)

    // 4. 双臂与双手 1:1 实时跟随玩家的每一次抬手、出拳、叉腰、交叉、举手、摆光线！
    if (this.profile) {
      if (pose.upperArmL) {
        this.aimBone(this.profile.bones.upperArmL, this.smUpperL)
        if (pose.lowerArmL) {
          this.aimBone(this.profile.bones.lowerArmL, this.smLowerL)
          this.aimBone(this.profile.bones.handL, this.smHandL, 0.75)
        }
      }
      if (pose.upperArmR) {
        this.aimBone(this.profile.bones.upperArmR, this.smUpperR)
        if (pose.lowerArmR) {
          this.aimBone(this.profile.bones.lowerArmR, this.smLowerR)
          this.aimBone(this.profile.bones.handR, this.smHandR, 0.75)
        }
      }
    }

    // 5. 手指开合智能匹配招式状态
    const isBladeHand =
      this.action === 'beam' ||
      this.beamChargeVisual > 0.12 ||
      this.action === 'disc' ||
      this.discChargeVisual > 0.12
    const curlAmt = isBladeHand
      ? 0.0
      : this.isGuarding
        ? 0.22
        : this.action === 'punch-left' || this.action === 'punch-right'
          ? 1.0
          : 0.75
    this.curlHand('L', curlAmt)
    this.curlHand('R', curlAmt)

    this.root.updateMatrixWorld(true)
  }

  /**
   * 键盘 / 触屏模式下的程序化经典战斗动画
   */
  private applyProceduralPose(elapsedTime: number) {
    if (!this.profile) return
    const b = this.profile.bones
    const leanRatio = this.currentX / 5.6
    const breath = Math.sin(elapsedTime * 2.6)
    let forwardStep = 0
    let bodyYaw = 0
    let bodyPitch = 0.04

    if (this.action === 'punch-left' || this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      forwardStep = p * 2.6
      bodyYaw = (this.action === 'punch-left' ? -1 : 1) * p * 0.32
      bodyPitch = 0.08 + p * 0.1
    } else if (this.action === 'kick-left' || this.action === 'kick-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      forwardStep = p * 3.0
      bodyYaw = (this.action === 'kick-left' ? -1 : 1) * p * 0.38
      bodyPitch = -0.14 * p
    } else if (this.action === 'beam') {
      const p = Math.min(1, this.actionTime / 0.18)
      forwardStep = 0.8 * p
      bodyPitch = -0.04 * p
    } else if (this.action === 'hit') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      forwardStep = -1.6 * p
      bodyPitch = -0.22 * p
    } else if (this.action === 'disc') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      forwardStep = 1.4 * p
      bodyYaw = (this.discChargeSide === 'left' ? -1 : 1) * p * 0.25
    }

    this.root.position.set(this.currentX, 0, this.baseZ - forwardStep)
    this.root.rotation.set(0, Math.PI + this.profile.facingYaw + bodyYaw, -leanRatio * 0.12)
    this.root.updateMatrixWorld(true)

    const hip = this.logical.get('hip')
    if (hip) {
      hip.position.y -= 0.055 + breath * 0.008
    }

    const thighL = this.logical.get('thighL')
    const shinL = this.logical.get('shinL')
    const thighR = this.logical.get('thighR')
    const shinR = this.logical.get('shinR')

    if (this.action === 'kick-left' || this.action === 'kick-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.root.updateMatrixWorld(true)
      if (this.action === 'kick-left') {
        this.aimBone(b.thighL, new THREE.Vector3(-0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone(b.shinL, new THREE.Vector3(-0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
      } else {
        this.aimBone(b.thighR, new THREE.Vector3(0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone(b.shinR, new THREE.Vector3(0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
      }
    } else if (thighL && shinL && thighR && shinR) {
      thighL.rotation.x += 0.22
      thighL.rotation.z -= 0.14
      shinL.rotation.x -= 0.34
      thighR.rotation.x += 0.12
      thighR.rotation.z += 0.16
      shinR.rotation.x -= 0.24
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
      this.aimBone(b.upperArmR, new THREE.Vector3(0.42, -0.22, -0.88), blend)
      this.aimBone(b.lowerArmR, new THREE.Vector3(-0.04, 0.98, -0.18), blend)
      this.aimBone(b.upperArmL, new THREE.Vector3(-0.22, -0.42, -0.88), blend)
      this.aimBone(b.lowerArmL, new THREE.Vector3(0.95, 0.12, -0.28), blend)
      this.curlHand('R', 0)
      this.curlHand('L', 0)
    } else if (this.isGuarding || this.action === 'guard') {
      this.aimBone(b.upperArmL, new THREE.Vector3(0.18, -0.18, -0.96))
      this.aimBone(b.lowerArmL, new THREE.Vector3(0.65, 0.65, -0.38))
      this.aimBone(b.upperArmR, new THREE.Vector3(-0.18, -0.18, -0.96))
      this.aimBone(b.lowerArmR, new THREE.Vector3(-0.65, 0.65, -0.38))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.2)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(
        b.upperArmL,
        new THREE.Vector3(-0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96),
      )
      this.aimBone(b.lowerArmL, new THREE.Vector3(0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone(b.upperArmR, new THREE.Vector3(0.55, -0.58, -0.45))
      this.aimBone(b.lowerArmR, new THREE.Vector3(-0.32, 0.22, -0.9))
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(
        b.upperArmR,
        new THREE.Vector3(0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96),
      )
      this.aimBone(b.lowerArmR, new THREE.Vector3(-0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone(b.upperArmL, new THREE.Vector3(-0.55, -0.58, -0.45))
      this.aimBone(b.lowerArmL, new THREE.Vector3(0.32, 0.22, -0.9))
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
        this.aimBone(activeUpper, new THREE.Vector3(sx * 0.28, swingY, -0.92))
        this.aimBone(activeLower, new THREE.Vector3(sx * 0.12, swingY - 0.1, -0.98))
      } else {
        this.aimBone(activeUpper, new THREE.Vector3(sx * 0.35, 0.92, -0.18))
        this.aimBone(activeLower, new THREE.Vector3(sx * 0.12, 0.98, -0.15))
      }
      this.aimBone(idleUpper, new THREE.Vector3(-sx * 0.48, -0.55, -0.62))
      this.aimBone(idleLower, new THREE.Vector3(sx * 0.25, 0.28, -0.92))
      this.curlHand(isLeft ? 'L' : 'R', 0)
      this.curlHand(isLeft ? 'R' : 'L', 0.9)
    } else if (this.action === 'hit') {
      this.aimBone(b.upperArmL, new THREE.Vector3(-0.78, -0.18, -0.4))
      this.aimBone(b.lowerArmL, new THREE.Vector3(-0.55, 0.45, -0.68))
      this.aimBone(b.upperArmR, new THREE.Vector3(0.78, -0.18, -0.4))
      this.aimBone(b.lowerArmR, new THREE.Vector3(0.55, 0.45, -0.68))
      this.curlHand('L', 0.5)
      this.curlHand('R', 0.5)
    } else {
      const sway = breath * 0.05
      this.aimBone(b.upperArmL, new THREE.Vector3(-0.46, -0.35 + sway, -0.78))
      this.aimBone(b.lowerArmL, new THREE.Vector3(0.22, 0.42 + sway, -0.88))
      this.aimBone(b.upperArmR, new THREE.Vector3(0.56, -0.52 - sway, -0.62))
      this.aimBone(b.lowerArmR, new THREE.Vector3(-0.18, 0.24 - sway, -0.95))
      this.curlHand('L', 0.85)
      this.curlHand('R', 0.95)
    }

    this.root.updateMatrixWorld(true)
  }
}
