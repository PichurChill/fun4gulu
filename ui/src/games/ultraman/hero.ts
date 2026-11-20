import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { HeroAction } from './types'

const tmpV1 = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpQ1 = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()

/**
 * 迪迦奥特曼第三人称全身骨骼控制器
 * 模型：tiga.glb（52 根 FK 骨骼 + 发光双眼 + 彩色计时器）
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

  public readonly baseZ = 20
  public currentX = 0
  private targetX = 0
  private action: HeroAction = 'idle'
  private actionTime = 0
  private actionDuration = 0.35
  private beamChargeVisual = 0
  private discChargeVisual = 0
  private discChargeSide: 'left' | 'right' = 'right'
  private isGuarding = false
  private victoryAscent = 0

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

    // 归一化身高至 13.5，脚底精准贴地 y = 0
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
              // 让迪迦背部红紫银金属质感在阳光下更清晰饱满
              m.roughness = Math.min(m.roughness, 0.52)
              m.metalness = Math.max(m.metalness, 0.18)
            }
          }
        }
      }
    })

    // 读取 GLB 内嵌骨尾坐标，用于精确骨骼朝向控制
    const rigNode = model.getObjectByName('TigaBodyRig')
    const tips = (rigNode?.userData?.bone_tips ?? {}) as Record<string, [number, number, number]>
    for (const [name, tailArr] of Object.entries(tips)) {
      const bone = this.bones.get(name)
      if (!bone) continue
      const worldTail = model.localToWorld(new THREE.Vector3(tailArr[0], tailArr[1], tailArr[2]))
      this.boneTips.set(bone, bone.worldToLocal(worldTail))
    }
  }

  public setLean(lean: number) {
    this.targetX = THREE.MathUtils.clamp(lean, -1, 1) * 5.2
  }

  public setGuard(active: boolean) {
    this.isGuarding = active
  }

  public setBeamCharge(progress: number) {
    this.beamChargeVisual = THREE.MathUtils.clamp(progress, 0, 1)
  }

  public setDiscCharge(progress: number, side: 'left' | 'right' | null) {
    this.discChargeVisual = THREE.MathUtils.clamp(progress, 0, 1)
    if (side) this.discChargeSide = side
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

  public getBoneWorldPosition(boneName: string, fallbackOffset = new THREE.Vector3(0, 9, -2)): THREE.Vector3 {
    const bone = this.bones.get(boneName)
    if (bone) {
      bone.updateWorldMatrix(true, false)
      return bone.getWorldPosition(new THREE.Vector3())
    }
    return this.root.position.clone().add(fallbackOffset)
  }

  /** 获取右前臂发射哉佩利敖光线的上下两点（世界坐标） */
  public getBeamOriginSegment(): [THREE.Vector3, THREE.Vector3] {
    const elbow = this.getBoneWorldPosition('LowerArm_R', new THREE.Vector3(0.6, 8.8, -1.8))
    const wrist = this.getBoneWorldPosition('Hand_R', new THREE.Vector3(0.6, 10.6, -1.8))
    // 稍微向怪兽方向（-Z）前移 0.45，避免光柱穿模切进手臂皮肤
    elbow.z -= 0.45
    wrist.z -= 0.45
    return [elbow, wrist]
  }

  /** 获取八分光轮发射点 */
  public getDiscOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const bone = side === 'left' ? 'Hand_L' : 'Hand_R'
    const p = this.getBoneWorldPosition(bone, new THREE.Vector3(side === 'left' ? -2 : 2, 13.5, -1))
    p.y += 1.2
    return p
  }

  /** 获取出拳击打点 */
  public getFistOrigin(side: 'left' | 'right'): THREE.Vector3 {
    const bone = side === 'left' ? 'Hand_L' : 'Hand_R'
    return this.getBoneWorldPosition(bone, new THREE.Vector3(side === 'left' ? -1.2 : 1.2, 10, -2.5))
  }

  public update(dt: number, elapsedTime: number, dangerTimer: boolean) {
    if (!this.model) return

    // 更新动作计时
    if (this.action !== 'idle' && this.action !== 'victory') {
      this.actionTime += dt
      if (this.actionTime >= this.actionDuration) {
        this.action = 'idle'
        this.actionTime = 0
      }
    }

    // 重置所有骨骼到初始姿势
    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }
    for (const [bone, pos] of this.restPositions) {
      bone.position.copy(pos)
    }

    // 左右闪避平滑移动
    this.currentX += (this.targetX - this.currentX) * Math.min(1, dt * 10)
    const leanRatio = this.currentX / 5.2

    // 彩色计时器颜色与闪烁（低血量时变红闪灯）
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
      this.victoryAscent += dt
      const t = Math.min(1, this.victoryAscent / 2.2)
      const easeUp = t * t
      this.root.position.set(this.currentX * (1 - t), easeUp * 26, this.baseZ - easeUp * 14)
      this.root.rotation.set(easeUp * 0.28, Math.PI + Math.sin(this.victoryAscent * 1.4) * 0.2, 0)
      this.root.updateMatrixWorld(true)
      // 右拳笔直高举冲向天空，左臂贴身向后收紧
      this.aimBone('UpperArm_R', new THREE.Vector3(0.08, 0.96, -0.25))
      this.aimBone('LowerArm_R', new THREE.Vector3(0.04, 0.98, -0.2))
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.22, -0.92, 0.3))
      this.aimBone('LowerArm_L', new THREE.Vector3(-0.15, -0.95, 0.28))
      this.curlHand('R', 1)
      this.curlHand('L', 1)
      this.root.updateMatrixWorld(true)
      return
    }

    // 战斗位移与身体倾角
    const breath = Math.sin(elapsedTime * 2.6)
    let forwardStep = 0
    let bodyYaw = 0
    let bodyPitch = 0.04

    if (this.action === 'punch-left' || this.action === 'punch-right') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      forwardStep = p * 2.6
      bodyYaw = (this.action === 'punch-left' ? -1 : 1) * p * 0.32
      bodyPitch = 0.08 + p * 0.1
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

    // 下肢：经典稳健的奥特曼战斗微蹲弓步（双腿微微外展微屈，拒绝呆板站桩）
    const hip = this.bones.get('hip')
    if (hip) {
      hip.position.y -= 0.055 + breath * 0.008
    }
    const thighL = this.bones.get('Thigh_L')
    const shinL = this.bones.get('Shin_L')
    const thighR = this.bones.get('Thigh_R')
    const shinR = this.bones.get('Shin_R')
    if (thighL && shinL && thighR && shinR) {
      thighL.rotation.x += 0.22
      thighL.rotation.z -= 0.14
      shinL.rotation.x -= 0.34
      thighR.rotation.x += 0.12
      thighR.rotation.z += 0.16
      shinR.rotation.x -= 0.24
    }

    // 躯干与胸腔微倾 + 呼吸起伏
    const spineChest = this.bones.get('spineChest')
    if (spineChest) {
      spineChest.rotation.x += bodyPitch + breath * 0.018
    }
    const head = this.bones.get('head')
    if (head) {
      head.rotation.x -= bodyPitch * 0.5
    }
    this.root.updateMatrixWorld(true)

    // 根据当前状态决定双臂经典姿态
    if (this.action === 'beam' || this.beamChargeVisual > 0.08) {
      // 迪迦招牌 L 字哉佩利敖光线定势：
      // 右上臂向右前伸出，右前臂竖直向上；左上臂向胸前内收，左前臂水平横贴右肘！
      const blend = this.action === 'beam' ? 1 : Math.min(1, this.beamChargeVisual * 1.4)
      this.aimBone('UpperArm_R', new THREE.Vector3(0.42, -0.22, -0.88), blend)
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.04, 0.98, -0.18), blend)
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.22, -0.42, -0.88), blend)
      this.aimBone('LowerArm_L', new THREE.Vector3(0.95, 0.12, -0.28), blend)
      this.curlHand('R', 0) // 手刀并拢伸直
      this.curlHand('L', 0)
    } else if (this.isGuarding || this.action === 'guard') {
      // 胸前 X 双臂交叉防御姿态
      this.aimBone('UpperArm_L', new THREE.Vector3(0.18, -0.18, -0.96))
      this.aimBone('LowerArm_L', new THREE.Vector3(0.65, 0.65, -0.38))
      this.aimBone('UpperArm_R', new THREE.Vector3(-0.18, -0.18, -0.96))
      this.aimBone('LowerArm_R', new THREE.Vector3(-0.65, 0.65, -0.38))
      this.curlHand('L', 0.2)
      this.curlHand('R', 0.2)
    } else if (this.action === 'punch-left') {
      const p = Math.sin(Math.min(1, this.actionTime / this.actionDuration) * Math.PI)
      // 左拳直线爆裂前冲，右拳回拉护胸
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
      // 右拳直线爆裂前冲，左拳回拉护胸
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
        // 向前下方甩出光轮
        const p = Math.min(1, this.actionTime / this.actionDuration)
        const swingY = THREE.MathUtils.lerp(0.85, -0.25, p)
        this.aimBone(activeUpper, new THREE.Vector3(sx * 0.28, swingY, -0.92))
        this.aimBone(activeLower, new THREE.Vector3(sx * 0.12, swingY - 0.1, -0.98))
      } else {
        // 单手高举过头顶蓄力八分光轮
        this.aimBone(activeUpper, new THREE.Vector3(sx * 0.35, 0.92, -0.18))
        this.aimBone(activeLower, new THREE.Vector3(sx * 0.12, 0.98, -0.15))
      }
      this.aimBone(idleUpper, new THREE.Vector3(-sx * 0.48, -0.55, -0.62))
      this.aimBone(idleLower, new THREE.Vector3(sx * 0.25, 0.28, -0.92))
      this.curlHand(isLeft ? 'L' : 'R', 0)
      this.curlHand(isLeft ? 'R' : 'L', 0.9)
    } else if (this.action === 'hit') {
      // 受击双臂向两侧张开后仰
      this.aimBone('UpperArm_L', new THREE.Vector3(-0.78, -0.18, -0.4))
      this.aimBone('LowerArm_L', new THREE.Vector3(-0.55, 0.45, -0.68))
      this.aimBone('UpperArm_R', new THREE.Vector3(0.78, -0.18, -0.4))
      this.aimBone('LowerArm_R', new THREE.Vector3(0.55, 0.45, -0.68))
      this.curlHand('L', 0.5)
      this.curlHand('R', 0.5)
    } else {
      // 默认：迪迦经典起手格斗姿态（左臂微前架高，右臂收于胸侧蓄力，带呼吸节奏）
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
