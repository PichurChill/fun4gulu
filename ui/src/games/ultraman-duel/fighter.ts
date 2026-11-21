import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { FingerChain, HeroProfile } from '../ultraman/heroes'
import type { HeroAction, LiveBodyPose, Vec3Like } from '../ultraman/types'

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
 * 把 UltraGestureRecognizer 输出的「面朝 -Z 世界方向约定」旋转到本格斗家的朝向系：
 * facing = +1（面朝 +X）时绕 Y 轴旋转 -90°，facing = -1（面朝 -X）时旋转 +90°。
 * 玩家朝摄像头的正向出拳会精确映射为格斗家朝对手方向的出拳。
 */
export function rotateDirToFighterFrame(v: Vec3Like, facing: 1 | -1): Vec3Like {
  return facing > 0 ? { x: -v.z, y: v.y, z: v.x } : { x: v.z, y: v.y, z: -v.x }
}

function rotatePoseToFighterFrame(pose: LiveBodyPose, facing: 1 | -1): LiveBodyPose {
  const rot = (v: Vec3Like | null) => (v ? rotateDirToFighterFrame(v, facing) : null)
  return {
    ...pose,
    upperArmL: rot(pose.upperArmL),
    lowerArmL: rot(pose.lowerArmL),
    handL: rot(pose.handL),
    upperArmR: rot(pose.upperArmR),
    lowerArmR: rot(pose.lowerArmR),
    handR: rot(pose.handR),
    thighL: rot(pose.thighL),
    shinL: rot(pose.shinL),
    thighR: rot(pose.thighR),
    shinR: rot(pose.shinR),
  }
}

/**
 * 横版格斗战士控制器（迪迦 / 赛罗通用，复用 HeroProfile 骨骼绑定协议）
 *
 * 与 UltramanGameEngine 的 HeroController 的差异：
 * - 擂台为 Z = 0 的 X 轴横版，双方自动互朝对方（facing 动态 +/-1）
 * - 位置由对战引擎以绝对 targetX 驱动（走近 / 拉开），而非 lean 相对闪避
 * - 程序化招式动画方向全部按当前 facing 实时旋到面朝对手
 * - 新增 KO 倒地动画
 */
export class DuelFighter {
  public readonly root = new THREE.Group()
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
  private restAnkleY = 0.85

  /** 面朝方向：+1 面朝擂台 +X（对手在右），-1 面朝 -X（对手在左） */
  public facing: 1 | -1 = 1
  public currentX = 0
  private targetX = 0
  private action: HeroAction | 'ko' = 'idle'
  private actionTime = 0
  private actionDuration = 0.35
  private beamChargeVisual = 0
  private discChargeVisual = 0
  private discChargeSide: 'left' | 'right' = 'right'
  private beamArmSide: 'left' | 'right' = 'right'
  private isGuarding = false
  private victoryAscent = 0
  private koProgress = 0

  // 实时体感全身平滑状态（与 HeroController 相同的自适应速率平滑）
  private livePose: LiveBodyPose | null = null
  private lastLivePoseTime = -Infinity
  private manualJumpActive = false
  /** 程序化（键盘/CPU）跳跃相位：0 为落地，推进到 π 完成一次起跳弧线 */
  private manualJumpPhase = 0
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

  constructor(scene: THREE.Scene, startX: number, facing: 1 | -1) {
    this.root.name = 'DuelFighterRoot'
    this.root.rotation.order = 'YXZ'
    this.root.position.set(startX, 0, 0)
    this.currentX = startX
    this.targetX = startX
    this.facing = facing
    scene.add(this.root)
  }

  public async load(loader: GLTFLoader, profile: HeroProfile): Promise<void> {
    if (this.profile?.id === profile.id && this.model) return
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
            if (profile.timerMaterialNames.length > 0 && matches(profile.timerMaterialNames)) {
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

    // 单材质模型（如赛罗）：用首个身体材质承载危险能量脉冲
    if (this.timerMaterials.length === 0 && fallbackGlowMaterial) {
      this.timerMaterials.push(fallbackGlowMaterial)
    }

    this.logical.clear()
    for (const [key, actualName] of Object.entries(profile.bones)) {
      if (!actualName || key === 'fingersL' || key === 'fingersR') continue
      const bone = this.bones.get(actualName)
      if (bone) this.logical.set(key, bone)
    }

    // fail-fast：关键驱动骨或手指链缺失时立即暴露，绝不带着残缺绑定静默运行
    const requiredLimbs = [
      'upperArmL',
      'lowerArmL',
      'handL',
      'upperArmR',
      'lowerArmR',
      'handR',
      'thighL',
      'shinL',
      'footL',
      'thighR',
      'shinR',
      'footR',
      'head',
      'spineLower',
      'spineChest',
    ] as const
    const missing = requiredLimbs.filter((key) => !this.logical.has(key))
    if (missing.length > 0) {
      throw new Error(
        `[DuelFighter] ${profile.id} 模型缺少关键骨骼映射: ${missing.join(', ')}；` +
          `请核对 heroes.ts 骨名与 GLB 加载后的实际骨骼名`,
      )
    }
    for (const [sideName, fingers] of [
      ['fingersL', profile.bones.fingersL],
      ['fingersR', profile.bones.fingersR],
    ] as const) {
      for (const chainName of ['index', 'pinky', 'thumb'] as const) {
        if (!fingers[chainName].some((n) => this.bones.has(n))) {
          throw new Error(`[DuelFighter] ${profile.id} 模型 ${sideName}.${chainName} 手指骨链全部缺失`)
        }
      }
    }

    // 骨骼指向尾端：优先读取模型自带 bone_tips 元数据，缺失时用子骨世界位置推导
    let tips: Record<string, [number, number, number]> = {}
    model.traverse((node) => {
      const data = (node.userData?.bone_tips ?? null) as Record<
        string,
        [number, number, number]
      > | null
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
  }

  public dispose() {
    this.unloadModel()
    this.root.parent?.remove(this.root)
  }

  // ---- 对战引擎驱动接口 ----

  public setFacing(facing: 1 | -1) {
    this.facing = facing
  }

  /** 引擎直接驱动绝对目标 X（走近/拉开由引擎计算） */
  public setTargetX(x: number) {
    this.targetX = x
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

  /** 喂入摄像头动捕全身骨骼数据（内部按当前朝向旋入本格斗家坐标系） */
  public setLiveBodyPose(pose: LiveBodyPose | null, now: number) {
    if (!pose?.active) {
      this.livePose = null
      return
    }
    this.livePose = rotatePoseToFighterFrame(pose, this.facing)
    this.lastLivePoseTime = now
    this.beamArmSide = pose.beamArmSide
  }

  public isLiveTracking(now: number): boolean {
    return !!(this.livePose?.active && now - this.lastLivePoseTime < 650)
  }

  /** 键盘跳跃：无体感数据时的视觉起跳与跳跃闪避判定来源 */
  public setManualJump(active: boolean) {
    this.manualJumpActive = active
  }

  /** 是否处于滞空（用于攻击命中/闪避判定，体感/键盘两种驱动统一生效） */
  public isAirborne(): boolean {
    return this.smJumpHeight > 1.6 || this.manualJumpPhase > 0.18
  }

  public getJumpHeight(): number {
    return Math.max(this.smJumpHeight, this.manualJumpY())
  }

  private manualJumpY(): number {
    return this.manualJumpActive ? Math.sin(Math.min(Math.PI, this.manualJumpPhase)) * 4.2 : 0
  }

  public triggerAction(action: HeroAction | 'ko', duration: number) {
    this.action = action
    this.actionTime = 0
    this.actionDuration = duration
    if (action === 'victory') this.victoryAscent = 0
    if (action === 'ko') this.koProgress = 0
  }

  public getAction(): HeroAction | 'ko' {
    return this.action
  }

  public resetRound(startX: number, facing: 1 | -1) {
    this.action = 'idle'
    this.actionTime = 0
    this.currentX = startX
    this.targetX = startX
    this.facing = facing
    this.beamChargeVisual = 0
    this.discChargeVisual = 0
    this.isGuarding = false
    this.victoryAscent = 0
    this.koProgress = 0
    this.manualJumpPhase = 0
    this.livePose = null
    this.lastLivePoseTime = -Infinity
    this.manualJumpActive = false
    this.smJumpHeight = 0
    this.smCrouchDepth = 0
    this.root.rotation.set(0, this.baseYaw(), 0)
  }

  public resetAll() {
    this.resetRound(this.currentX, this.facing)
    this.smTorsoPitch = 0
    this.smTorsoRoll = 0
    this.smTorsoYaw = 0
  }

  private baseYaw(): number {
    // 模型静息面朝 +Z：facing +1（面朝 +X）转 +90°，facing -1（面朝 -X）转 -90°
    return (this.facing > 0 ? Math.PI / 2 : -Math.PI / 2) + (this.profile?.facingYaw ?? 0)
  }

  /** 程序化动画方向：把「面朝 -Z 约定」的局部方向旋到当前朝向 */
  private local(x: number, y: number, z: number): THREE.Vector3 {
    return this.facing > 0 ? new THREE.Vector3(-z, y, x) : new THREE.Vector3(z, y, -x)
  }

  // ---- 骨骼驱动核心（与 HeroController 同源的 aimBone / curlHand 方案） ----

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
        this.aimBone(chain[j]!, dir)
      }
    }
  }

  // ---- 攻击/特效挂点（世界坐标，朝向无关） ----

  public getBoneWorldPosition(logicalName: string, fallbackOffset: THREE.Vector3): THREE.Vector3 {
    const bone = this.logical.get(logicalName)
    if (bone) {
      bone.updateWorldMatrix(true, false)
      return bone.getWorldPosition(new THREE.Vector3())
    }
    return this.root.position.clone().add(fallbackOffset)
  }

  public getCenter(): THREE.Vector3 {
    return this.getBoneWorldPosition('spineChest', new THREE.Vector3(0, 8.6, 0))
  }

  public getBeamOriginSegment(): [THREE.Vector3, THREE.Vector3] {
    const suffix = this.beamArmSide === 'left' ? 'L' : 'R'
    const sx = this.beamArmSide === 'left' ? -0.6 : 0.6
    const elbow = this.getBoneWorldPosition(`lowerArm${suffix}`, new THREE.Vector3(sx, 8.8, 0))
    const wrist = this.getBoneWorldPosition(`hand${suffix}`, new THREE.Vector3(sx, 10.6, 0))
    elbow.x -= this.facing * 0.45
    wrist.x -= this.facing * 0.45
    return [elbow, wrist]
  }

  public getDiscOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(`hand${suffix}`, new THREE.Vector3(0, 13.5, 0))
    p.y += 1.15
    return p
  }

  public getFistOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    return this.getBoneWorldPosition(`hand${suffix}`, new THREE.Vector3(0, 10, 0))
  }

  public getFootOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const suffix = side === 'left' ? 'L' : 'R'
    const p = this.getBoneWorldPosition(`foot${suffix}`, new THREE.Vector3(0, 5.5, 0))
    p.x -= this.facing * 0.6
    return p
  }

  // ---- 每帧更新 ----

  public update(dt: number, elapsedTime: number, dangerTimer: boolean, nowMs = performance.now()) {
    if (!this.model) return

    if (this.action !== 'idle' && this.action !== 'victory' && this.action !== 'ko') {
      this.actionTime += dt
      if (this.actionTime >= this.actionDuration) {
        this.action = 'idle'
        this.actionTime = 0
      }
    }

    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }
    for (const [bone, pos] of this.restPositions) {
      bone.position.copy(pos)
    }

    // 位置平滑（走向引擎给定的目标点）
    this.currentX += (this.targetX - this.currentX) * Math.min(1, dt * 11)

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

    // 键盘/CPU 跳跃相位推进（体感模式由 livePose.jumpHeight 接管，二者取最大值）
    if (this.manualJumpActive) {
      this.manualJumpPhase += dt * 2.4
    } else {
      this.manualJumpPhase = 0
    }

    if (this.action === 'ko') {
      this.updateKnockdown(dt)
      return
    }
    if (this.action === 'victory') {
      this.updateVictoryAscent(dt)
      return
    }

    if (this.isLiveTracking(nowMs) && this.livePose) {
      this.applyLiveBodyPose(this.livePose, dt, elapsedTime)
      return
    }

    this.applyProceduralPose(elapsedTime)
  }

  /** KO 倒地：向后仰倒砸地（撞击瞬间由引擎触发尘土特效） */
  private updateKnockdown(dt: number) {
    this.actionTime += dt
    this.koProgress = Math.min(1, this.actionTime / 0.7)
    const p = this.koProgress
    const ease = 1 - Math.pow(1 - p, 2.2)
    const back = this.local(0, 0, 1).multiplyScalar(ease * 4.6)
    this.root.position.set(this.currentX + back.x, Math.max(0, 1.4 * Math.sin(Math.PI * Math.min(1, p * 1.15)) * (1 - p * 0.55)), 0)
    this.root.rotation.set(-1.42 * ease, this.baseYaw(), 0)
    this.root.updateMatrixWorld(true)

    if (this.profile) {
      const b = this.profile.bones
      this.aimBone(b.upperArmL, this.local(-0.72, 0.5, 0.42))
      this.aimBone(b.upperArmR, this.local(0.72, 0.5, 0.42))
      this.curlHand('L', 0.35)
      this.curlHand('R', 0.35)
    }
    this.root.updateMatrixWorld(true)
  }

  /** 胜利升空（沿用经典胜利飞离镜头动画） */
  private updateVictoryAscent(dt: number) {
    this.victoryAscent += dt
    const t = Math.min(1, this.victoryAscent / 2.2)
    const easeUp = t * t
    const forward = this.local(0, 0, -1).multiplyScalar(easeUp * 14)
    this.root.position.set(this.currentX, easeUp * 26, forward.z)
    this.root.rotation.set(
      easeUp * 0.28,
      this.baseYaw() + Math.sin(this.victoryAscent * 1.4) * 0.2,
      0,
    )
    this.root.updateMatrixWorld(true)
    if (!this.profile) return
    this.aimBone(this.profile.bones.upperArmR, this.local(0.08, 0.96, -0.25))
    this.aimBone(this.profile.bones.lowerArmR, this.local(0.04, 0.98, -0.2))
    this.aimBone(this.profile.bones.upperArmL, this.local(-0.22, -0.92, 0.3))
    this.aimBone(this.profile.bones.lowerArmL, this.local(-0.15, -0.95, 0.28))
    this.curlHand('R', 1)
    this.curlHand('L', 1)
    this.root.updateMatrixWorld(true)
  }

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

    const jumpTarget = this.manualJumpActive && !pose.jumpHeight ? 4.6 : pose.jumpHeight
    this.smTorsoPitch = THREE.MathUtils.lerp(this.smTorsoPitch, pose.torsoPitch, alpha)
    this.smTorsoRoll = THREE.MathUtils.lerp(this.smTorsoRoll, pose.torsoRoll, alpha)
    this.smTorsoYaw = THREE.MathUtils.lerp(this.smTorsoYaw, pose.torsoYaw, alpha)
    this.smHeadYaw = THREE.MathUtils.lerp(this.smHeadYaw, pose.headYaw, alpha)
    this.smHeadPitch = THREE.MathUtils.lerp(this.smHeadPitch, pose.headPitch, alpha)
    this.smHeadRoll = THREE.MathUtils.lerp(this.smHeadRoll, pose.headRoll, alpha)
    this.smJumpHeight = THREE.MathUtils.lerp(this.smJumpHeight, jumpTarget, alpha)
    this.smCrouchDepth = THREE.MathUtils.lerp(this.smCrouchDepth, pose.crouchDepth, alpha)

    if (pose.upperArmL)
      lerpVec(this.smUpperL, pose.upperArmL, adaptiveAlpha(this.smUpperL, pose.upperArmL, alpha))
    if (pose.lowerArmL)
      lerpVec(this.smLowerL, pose.lowerArmL, adaptiveAlpha(this.smLowerL, pose.lowerArmL, alpha))
    if (pose.handL) lerpVec(this.smHandL, pose.handL, adaptiveAlpha(this.smHandL, pose.handL, alpha))
    else if (pose.lowerArmL) lerpVec(this.smHandL, pose.lowerArmL, alpha)

    if (pose.upperArmR)
      lerpVec(this.smUpperR, pose.upperArmR, adaptiveAlpha(this.smUpperR, pose.upperArmR, alpha))
    if (pose.lowerArmR)
      lerpVec(this.smLowerR, pose.lowerArmR, adaptiveAlpha(this.smLowerR, pose.lowerArmR, alpha))
    if (pose.handR) lerpVec(this.smHandR, pose.handR, adaptiveAlpha(this.smHandR, pose.handR, alpha))
    else if (pose.lowerArmR) lerpVec(this.smHandR, pose.lowerArmR, alpha)

    if (pose.thighL)
      lerpVec(this.smThighL, pose.thighL, adaptiveAlpha(this.smThighL, pose.thighL, alpha))
    if (pose.shinL)
      lerpVec(this.smShinL, pose.shinL, adaptiveAlpha(this.smShinL, pose.shinL, alpha))
    if (pose.thighR)
      lerpVec(this.smThighR, pose.thighR, adaptiveAlpha(this.smThighR, pose.thighR, alpha))
    if (pose.shinR)
      lerpVec(this.smShinR, pose.shinR, adaptiveAlpha(this.smShinR, pose.shinR, alpha))

    // 受击后仰震动（沿 -facing 方向，叠加在真人姿态上）
    let hitBack = 0
    let hitPitch = 0
    if (this.action === 'hit') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      hitBack = 1.4 * p
      hitPitch = -0.18 * p
    }
    const hitOffset = this.local(0, 0, hitBack)

    this.root.position.set(this.currentX + hitOffset.x, this.smJumpHeight, 0)
    this.root.rotation.set(0, this.baseYaw() + this.smTorsoYaw * 0.45, 0)
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
      this.aimBone(this.profile.bones.thighL, this.smThighL)
      if (pose.shinL) this.aimBone(this.profile.bones.shinL, this.smShinL)
      this.aimBone(this.profile.bones.thighR, this.smThighR)
      if (pose.shinR) this.aimBone(this.profile.bones.shinR, this.smShinR)

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

  /** 键盘 / CPU / 无识别帧时的程序化战斗动画（方向已按 facing 朝向对手） */
  private applyProceduralPose(elapsedTime: number) {
    if (!this.profile) return
    const b = this.profile.bones
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

    const stepOffset = this.local(0, 0, -forwardStep)
    this.root.position.set(this.currentX + stepOffset.x, this.manualJumpY(), stepOffset.z)
    this.root.rotation.set(0, this.baseYaw() + bodyYaw, 0)
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
        this.aimBone(b.thighL, this.local(-0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone(b.shinL, this.local(-0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
      } else {
        this.aimBone(b.thighR, this.local(0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone(b.shinR, this.local(0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
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
      this.aimBone(b.upperArmR, this.local(0.42, -0.22, -0.88), blend)
      this.aimBone(b.lowerArmR, this.local(-0.04, 0.98, -0.18), blend)
      this.aimBone(b.upperArmL, this.local(-0.22, -0.42, -0.88), blend)
      this.aimBone(b.lowerArmL, this.local(0.95, 0.12, -0.28), blend)
      this.curlHand('R', 0)
      this.curlHand('L', 0)
    } else if (this.isGuarding || this.action === 'guard') {
      this.aimBone(b.upperArmL, this.local(0.18, -0.18, -0.96))
      this.aimBone(b.lowerArmL, this.local(0.65, 0.65, -0.38))
      this.aimBone(b.upperArmR, this.local(-0.18, -0.18, -0.96))
      this.aimBone(b.lowerArmR, this.local(-0.65, 0.65, -0.38))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.2)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(b.upperArmL, this.local(-0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96))
      this.aimBone(b.lowerArmL, this.local(0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone(b.upperArmR, this.local(0.55, -0.58, -0.45))
      this.aimBone(b.lowerArmR, this.local(-0.32, 0.22, -0.9))
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(b.upperArmR, this.local(0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96))
      this.aimBone(b.lowerArmR, this.local(-0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone(b.upperArmL, this.local(-0.55, -0.58, -0.45))
      this.aimBone(b.lowerArmL, this.local(0.32, 0.22, -0.9))
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
        this.aimBone(activeUpper, this.local(sx * 0.28, swingY, -0.92))
        this.aimBone(activeLower, this.local(sx * 0.12, swingY - 0.1, -0.98))
      } else {
        this.aimBone(activeUpper, this.local(sx * 0.35, 0.92, -0.18))
        this.aimBone(activeLower, this.local(sx * 0.12, 0.98, -0.15))
      }
      this.aimBone(idleUpper, this.local(-sx * 0.48, -0.55, -0.62))
      this.aimBone(idleLower, this.local(sx * 0.25, 0.28, -0.92))
      this.curlHand(isLeft ? 'L' : 'R', 0)
      this.curlHand(isLeft ? 'R' : 'L', 0.9)
    } else if (this.action === 'hit') {
      this.aimBone(b.upperArmL, this.local(-0.78, -0.18, -0.4))
      this.aimBone(b.lowerArmL, this.local(-0.55, 0.45, -0.68))
      this.aimBone(b.upperArmR, this.local(0.78, -0.18, -0.4))
      this.aimBone(b.lowerArmR, this.local(0.55, 0.45, -0.68))
      this.curlHand('L', 0.5)
      this.curlHand('R', 0.5)
    } else {
      const sway = breath * 0.05
      this.aimBone(b.upperArmL, this.local(-0.46, -0.35 + sway, -0.78))
      this.aimBone(b.lowerArmL, this.local(0.22, 0.42 + sway, -0.88))
      this.aimBone(b.upperArmR, this.local(0.56, -0.52 - sway, -0.62))
      this.aimBone(b.lowerArmR, this.local(-0.18, 0.24 - sway, -0.95))
      this.curlHand('L', 0.85)
      this.curlHand('R', 0.95)
    }

    this.root.updateMatrixWorld(true)
  }
}
