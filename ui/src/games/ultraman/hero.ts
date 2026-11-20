import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
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
 * 迪迦奥特曼第三人称全身骨骼控制器
 * 支持两种无缝衔接的驱动模式：
 * 1) 体感实时全身动捕重定向（头、脊柱、双臂、双手、双腿、下蹲/跳跃 1:1 实时同步玩家）
 * 2) 键盘/触屏程序化经典招式动画（出拳、飞踢、交叉防御、光轮、L字光线、胜利升空）
 */
export class TigaHeroController {
  public readonly root = new THREE.Group()
  private model: THREE.Object3D | null = null
  private bones = new Map<string, THREE.Bone>()
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private restPositions = new Map<THREE.Bone, THREE.Vector3>()
  private boneTips = new Map<THREE.Bone, THREE.Vector3>()
  private timerMaterial: THREE.MeshStandardMaterial | null = null
  private eyeMaterial: THREE.MeshStandardMaterial | null = null
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
    this.root.name = 'TigaHeroRoot'
    this.root.position.set(0, 0, this.baseZ)
    // 原模型朝向 +Z，绕 Y 旋转 PI 后背对镜头、面朝前方 -Z 的怪兽
    this.root.rotation.set(0, Math.PI, 0)
    scene.add(this.root)
  }

  public async load(loader: GLTFLoader, url: string): Promise<void> {
    const gltf = await loader.loadAsync(url)
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
            if (m.name === 'Tiga color timer' || mesh.name.includes('TigaEnergy')) {
              if (!mesh.name.includes('Container')) {
                this.timerMaterial = m
                m.emissive = new THREE.Color(0x22d3ee)
                m.emissiveIntensity = 1.6
              }
            } else if (m.name === 'Tiga eyes' || mesh.name.includes('TigaEyes')) {
              this.eyeMaterial = m
              m.emissive = new THREE.Color(0xfff4c2)
              m.emissiveIntensity = 1.8
            } else {
              m.roughness = Math.min(m.roughness, 0.52)
              m.metalness = Math.max(m.metalness, 0.18)
            }
          }
        }
      }
    })

    const rigNode = model.getObjectByName('TigaBodyRig')
    const tips = (rigNode?.userData?.bone_tips ?? {}) as Record<string, [number, number, number]>
    for (const [name, tailArr] of Object.entries(tips)) {
      const bone = this.bones.get(name)
      if (!bone) continue
      const worldTail = model.localToWorld(new THREE.Vector3(tailArr[0], tailArr[1], tailArr[2]))
      this.boneTips.set(bone, bone.worldToLocal(worldTail))
    }

    // 记录静止脚踝高度，用于动捕踢腿/扎马步时保持支撑脚贴地
    const footL = this.bones.get('Foot_L')
    const footR = this.bones.get('Foot_R')
    if (footL && footR) {
      this.root.updateMatrixWorld(true)
      this.restAnkleY = Math.min(
        footL.getWorldPosition(new THREE.Vector3()).y,
        footR.getWorldPosition(new THREE.Vector3()).y,
      )
    }
  }

  public setLean(lean: number) {
    this.targetX = THREE.MathUtils.clamp(lean, -1, 1) * 5.6
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
    this.root.rotation.set(0, Math.PI, 0)
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

  /** 弯曲单手全部手指（0=完全伸直手刀，1=紧握拳头） */
  private curlHand(side: 'L' | 'R', amount: number) {
    const t = THREE.MathUtils.clamp(amount, 0, 1)
    const sign = side === 'L' ? 1 : -1
    const fingers = ['Index', 'Mid', 'Ring', 'Pinky']
    for (const finger of fingers) {
      for (let j = 1; j <= 3; j++) {
        const bone = this.bones.get(`${finger}${j}_${side}`)
        if (bone) {
          bone.rotation.z += sign * t * (j === 1 ? 0.95 : 1.05)
        }
      }
    }
    const thumb1 = this.bones.get(`Thumb1_${side}`)
    const thumb2 = this.bones.get(`Thumb2_${side}`)
    if (thumb1) thumb1.rotation.y -= sign * t * 0.55
    if (thumb2) thumb2.rotation.z += sign * t * 0.65
  }

  public getBoneWorldPosition(
    boneName: string,
    fallbackOffset = new THREE.Vector3(0, 9, -2),
  ): THREE.Vector3 {
    const bone = this.bones.get(boneName)
    if (bone) {
      bone.updateWorldMatrix(true, false)
      return bone.getWorldPosition(new THREE.Vector3())
    }
    return this.root.position.clone().add(fallbackOffset)
  }

  /** 获取当前发射哉佩利敖光线的前臂上下两点（自动跟随玩家竖直的那侧手臂） */
  public getBeamOriginSegment(): [THREE.Vector3, THREE.Vector3] {
    const suffix = this.beamArmSide === 'left' ? 'L' : 'R'
    const sx = this.beamArmSide === 'left' ? -0.6 : 0.6
    const elbow = this.getBoneWorldPosition(`LowerArm_${suffix}`, new THREE.Vector3(sx, 8.8, -1.8))
    const wrist = this.getBoneWorldPosition(`Hand_${suffix}`, new THREE.Vector3(sx, 10.6, -1.8))
    elbow.z -= 0.45
    wrist.z -= 0.45
    return [elbow, wrist]
  }

  /** 获取八分光轮发射点（严格跟随真实举起的手掌） */
  public getDiscOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const bone = side === 'left' ? 'Hand_L' : 'Hand_R'
    const p = this.getBoneWorldPosition(
      bone,
      new THREE.Vector3(side === 'left' ? -2 : 2, 13.5, -1),
    )
    p.y += 1.15
    return p
  }

  /** 获取出拳击打点（严格跟随真实拳头位置） */
  public getFistOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const bone = side === 'left' ? 'Hand_L' : 'Hand_R'
    return this.getBoneWorldPosition(
      bone,
      new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 10, -2.5),
    )
  }

  /** 获取奥特飞踢脚尖发射点 */
  public getFootOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const bone = side === 'left' ? 'Foot_L' : 'Foot_R'
    const p = this.getBoneWorldPosition(
      bone,
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
    if (this.timerMaterial) {
      if (dangerTimer) {
        const blink = Math.sin(elapsedTime * 11.5) > 0
        this.timerMaterial.emissive.setHex(blink ? 0xff1f3d : 0x550011)
        this.timerMaterial.emissiveIntensity = blink ? 3.2 : 0.4
      } else {
        this.timerMaterial.emissive.setHex(0x28e0ff)
        this.timerMaterial.emissiveIntensity = 1.6 + Math.sin(elapsedTime * 3.5) * 0.25
      }
    }
    if (this.eyeMaterial) {
      this.eyeMaterial.emissiveIntensity = 1.7 + Math.sin(elapsedTime * 2.5) * 0.2
    }

    // 胜利升空特殊动画
    if (this.action === 'victory') {
      this.updateVictoryAscent(dt)
      return
    }

    // 优先使用摄像头全身实时动捕姿态：迪迦整体一举一动完全跟随识别到的真人！
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
    this.root.rotation.set(easeUp * 0.28, Math.PI + Math.sin(this.victoryAscent * 1.4) * 0.2, 0)
    this.root.updateMatrixWorld(true)
    this.aimBone('UpperArm_R', new THREE.Vector3(0.08, 0.96, -0.25))
    this.aimBone('LowerArm_R', new THREE.Vector3(0.04, 0.98, -0.2))
    this.aimBone('UpperArm_L', new THREE.Vector3(-0.22, -0.92, 0.3))
    this.aimBone('LowerArm_L', new THREE.Vector3(-0.15, -0.95, 0.28))
    this.curlHand('R', 1)
    this.curlHand('L', 1)
    this.root.updateMatrixWorld(true)
  }

  /**
   * 实时全身动捕驱动：平滑映射头、脊柱、双臂、双手、双腿、下蹲与起跳
   */
  private applyLiveBodyPose(pose: LiveBodyPose, dt: number, elapsedTime: number) {
    // 指数平滑系数：约 55ms 响应时间，既极快跟手又彻底消除摄像头抖动
    const alpha = 1 - Math.exp(-dt * 18)

    this.smTorsoPitch = THREE.MathUtils.lerp(this.smTorsoPitch, pose.torsoPitch, alpha)
    this.smTorsoRoll = THREE.MathUtils.lerp(this.smTorsoRoll, pose.torsoRoll, alpha)
    this.smTorsoYaw = THREE.MathUtils.lerp(this.smTorsoYaw, pose.torsoYaw, alpha)
    this.smHeadYaw = THREE.MathUtils.lerp(this.smHeadYaw, pose.headYaw, alpha)
    this.smHeadPitch = THREE.MathUtils.lerp(this.smHeadPitch, pose.headPitch, alpha)
    this.smHeadRoll = THREE.MathUtils.lerp(this.smHeadRoll, pose.headRoll, alpha)
    this.smJumpHeight = THREE.MathUtils.lerp(this.smJumpHeight, pose.jumpHeight, alpha)
    this.smCrouchDepth = THREE.MathUtils.lerp(this.smCrouchDepth, pose.crouchDepth, alpha)

    if (pose.upperArmL) lerpVec(this.smUpperL, pose.upperArmL, alpha)
    if (pose.lowerArmL) lerpVec(this.smLowerL, pose.lowerArmL, alpha)
    if (pose.handL) lerpVec(this.smHandL, pose.handL, alpha)
    else if (pose.lowerArmL) lerpVec(this.smHandL, pose.lowerArmL, alpha)

    if (pose.upperArmR) lerpVec(this.smUpperR, pose.upperArmR, alpha)
    if (pose.lowerArmR) lerpVec(this.smLowerR, pose.lowerArmR, alpha)
    if (pose.handR) lerpVec(this.smHandR, pose.handR, alpha)
    else if (pose.lowerArmR) lerpVec(this.smHandR, pose.lowerArmR, alpha)

    if (pose.thighL) lerpVec(this.smThighL, pose.thighL, alpha)
    if (pose.shinL) lerpVec(this.smShinL, pose.shinL, alpha)
    if (pose.thighR) lerpVec(this.smThighR, pose.thighR, alpha)
    if (pose.shinR) lerpVec(this.smShinR, pose.shinR, alpha)

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
    this.root.rotation.set(0, Math.PI + this.smTorsoYaw * 0.45, 0)
    this.root.updateMatrixWorld(true)

    // 1. 脊柱分段弯曲（俯仰 + 侧倾 + 扭腰，流畅自然）
    const spineLower = this.bones.get('spineLower')
    const spineUpper = this.bones.get('spineUpper')
    const spineChest = this.bones.get('spineChest')
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
    const neckUpper = this.bones.get('neckUpper')
    const head = this.bones.get('head')
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
    const hip = this.bones.get('hip')
    if (pose.coverage === 'full' && pose.thighL && pose.thighR) {
      this.aimBone('Thigh_L', this.smThighL)
      if (pose.shinL) this.aimBone('Shin_L', this.smShinL)
      this.aimBone('Thigh_R', this.smThighR)
      if (pose.shinR) this.aimBone('Shin_R', this.smShinR)

      // 自动支撑脚贴地校正：计算当前左右脚踝世界最低点，贴齐地面再叠加跳跃高度
      this.root.updateMatrixWorld(true)
      const footL = this.bones.get('Foot_L')
      const footR = this.bones.get('Foot_R')
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
      const thighL = this.bones.get('Thigh_L')
      const shinL = this.bones.get('Shin_L')
      const thighR = this.bones.get('Thigh_R')
      const shinR = this.bones.get('Shin_R')
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
    if (pose.upperArmL) {
      this.aimBone('UpperArm_L', this.smUpperL)
      if (pose.lowerArmL) {
        this.aimBone('LowerArm_L', this.smLowerL)
        this.aimBone('Hand_L', this.smHandL, 0.75)
      }
    }
    if (pose.upperArmR) {
      this.aimBone('UpperArm_R', this.smUpperR)
      if (pose.lowerArmR) {
        this.aimBone('LowerArm_R', this.smLowerR)
        this.aimBone('Hand_R', this.smHandR, 0.75)
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
    this.root.rotation.set(0, Math.PI + bodyYaw, -leanRatio * 0.12)
    this.root.updateMatrixWorld(true)

    const hip = this.bones.get('hip')
    if (hip) {
      hip.position.y -= 0.055 + breath * 0.008
    }

    const thighL = this.bones.get('Thigh_L')
    const shinL = this.bones.get('Shin_L')
    const thighR = this.bones.get('Thigh_R')
    const shinR = this.bones.get('Shin_R')

    if (this.action === 'kick-left' || this.action === 'kick-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      const isLeft = this.action === 'kick-left'
      this.root.updateMatrixWorld(true)
      if (isLeft) {
        this.aimBone('Thigh_L', new THREE.Vector3(-0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone('Shin_L', new THREE.Vector3(-0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
      } else {
        this.aimBone('Thigh_R', new THREE.Vector3(0.12, 0.32 * p - 0.85 * (1 - p), -0.92 * p - 0.15))
        this.aimBone('Shin_R', new THREE.Vector3(0.08, 0.28 * p - 0.92 * (1 - p), -0.95 * p))
      }
    } else if (thighL && shinL && thighR && shinR) {
      thighL.rotation.x += 0.22
      thighL.rotation.z -= 0.14
      shinL.rotation.x -= 0.34
      thighR.rotation.x += 0.12
      thighR.rotation.z += 0.16
      shinR.rotation.x -= 0.24
    }

    const spineChest = this.bones.get('spineChest')
    if (spineChest) {
      spineChest.rotation.x += bodyPitch + breath * 0.018
    }
    const head = this.bones.get('head')
    if (head) {
      head.rotation.x -= bodyPitch * 0.5
    }
    this.root.updateMatrixWorld(true)

    if (this.action === 'beam' || this.beamChargeVisual > 0.08) {
      const blend = this.action === 'beam' ? 1 : Math.min(1, this.beamChargeVisual * 1.4)
      this.aimBone('UpperArm_R', new THREE.Vector3(0.42, -0.22, -0.88), blend)
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.04, 0.98, -0.18), blend)
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.22, -0.42, -0.88), blend)
      this.aimBone('LowerArm_L', new THREE.Vector3(0.95, 0.12, -0.28), blend)
      this.curlHand('R', 0)
      this.curlHand('L', 0)
    } else if (this.isGuarding || this.action === 'guard') {
      this.aimBone('UpperArm_L', new THREE.Vector3(0.18, -0.18, -0.96))
      this.aimBone('LowerArm_L', new THREE.Vector3(0.65, 0.65, -0.38))
      this.aimBone('UpperArm_R', new THREE.Vector3(-0.18, -0.18, -0.96))
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.65, 0.65, -0.38))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.2)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(
        'UpperArm_L',
        new THREE.Vector3(-0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96),
      )
      this.aimBone('LowerArm_L', new THREE.Vector3(0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone('UpperArm_R', new THREE.Vector3(0.55, -0.58, -0.45))
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.32, 0.22, -0.9))
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      this.aimBone(
        'UpperArm_R',
        new THREE.Vector3(0.18 * (1 - p), 0.14 * p - 0.15 * (1 - p), -0.96),
      )
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.06, 0.16 * p + 0.1, -0.98))
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.55, -0.58, -0.45))
      this.aimBone('LowerArm_L', new THREE.Vector3(0.32, 0.22, -0.9))
      this.curlHand('L', 1)
      this.curlHand('R', 1)
    } else if (this.action === 'disc' || this.discChargeVisual > 0.08) {
      const isLeft = this.discChargeSide === 'left'
      const activeUpper = isLeft ? 'UpperArm_L' : 'UpperArm_R'
      const activeLower = isLeft ? 'LowerArm_L' : 'LowerArm_R'
      const idleUpper = isLeft ? 'UpperArm_R' : 'UpperArm_L'
      const idleLower = isLeft ? 'LowerArm_R' : 'LowerArm_L'
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
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.78, -0.18, -0.4))
      this.aimBone('LowerArm_L', new THREE.Vector3(-0.55, 0.45, -0.68))
      this.aimBone('UpperArm_R', new THREE.Vector3(0.78, -0.18, -0.4))
      this.aimBone('LowerArm_R', new THREE.Vector3(0.55, 0.45, -0.68))
      this.curlHand('L', 0.5)
      this.curlHand('R', 0.5)
    } else {
      const sway = breath * 0.05
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.46, -0.35 + sway, -0.78))
      this.aimBone('LowerArm_L', new THREE.Vector3(0.22, 0.42 + sway, -0.88))
      this.aimBone('UpperArm_R', new THREE.Vector3(0.56, -0.52 - sway, -0.62))
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.18, 0.24 - sway, -0.95))
      this.curlHand('L', 0.85)
      this.curlHand('R', 0.95)
    }

    this.root.updateMatrixWorld(true)
  }
}
