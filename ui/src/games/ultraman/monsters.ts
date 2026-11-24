import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KaijuEncounter, WINDUP_TIME } from './encounter'
import type { MonsterSpec } from './types'

export const MONSTER_WAVES: MonsterSpec[] = [
  {
    id: 'baltan',
    modelUrl: '/models/ultraman/baltan.glb',
    maxHp: 320,
    targetHeight: 16.5,
    baseZ: -5,
    accentColor: 0xff5a36,
    attacks: ['fireball', 'melee'],
    attackDamage: 14,
    attackInterval: 4.2,
    defaultTheme: 'seaside',
    facingOffsetY: 0,
  },
  {
    id: 'ganq',
    modelUrl: '/models/ultraman/ganq.glb',
    maxHp: 420,
    targetHeight: 17.5,
    baseZ: -6,
    accentColor: 0xb048ff,
    attacks: ['fireball', 'dark-beam'],
    attackDamage: 16,
    attackInterval: 4.0,
    defaultTheme: 'city',
    isStaticMesh: true,
    facingOffsetY: 0,
  },
  {
    id: 'zetton',
    modelUrl: '/models/ultraman/zetton.glb',
    maxHp: 540,
    targetHeight: 18.0,
    baseZ: -6,
    accentColor: 0xff8c1a,
    attacks: ['fireball', 'melee', 'fireball'],
    attackDamage: 18,
    attackInterval: 3.6,
    defaultTheme: 'mountain',
    facingOffsetY: 0,
  },
  {
    id: 'gomora-mecha',
    modelUrl: '/models/ultraman/gomora-mecha.glb',
    maxHp: 680,
    targetHeight: 18.5,
    baseZ: -7,
    accentColor: 0xff3b5c,
    attacks: ['melee', 'dark-beam', 'fireball'],
    attackDamage: 20,
    attackInterval: 3.4,
    defaultTheme: 'city',
    facingOffsetY: 0,
  },
  {
    id: 'gatanothor',
    modelUrl: '/models/ultraman/gatanothor.glb',
    maxHp: 900,
    targetHeight: 20.5,
    baseZ: -9,
    accentColor: 0x9c27ff,
    attacks: ['dark-beam', 'fireball', 'melee'],
    attackDamage: 22,
    attackInterval: 3.2,
    defaultTheme: 'volcano',
    facingOffsetY: 0,
  },
]

const normalizeBoneKey = (name: string) => name.replace(/[ ._]/g, '').toLowerCase()

interface MonsterRig {
  hips: THREE.Bone | null
  chest: THREE.Bone | null
  head: THREE.Bone | null
  armL: THREE.Bone | null
  armR: THREE.Bone | null
  foreL: THREE.Bone | null
  foreR: THREE.Bone | null
  jaw: THREE.Bone | null
  handL: THREE.Bone | null
  handR: THREE.Bone | null
  clawL: THREE.Bone | null
  clawR: THREE.Bone | null
  thighL: THREE.Bone | null
  thighR: THREE.Bone | null
  shinL: THREE.Bone | null
  shinR: THREE.Bone | null
  tail: THREE.Bone[]
  tentacles: THREE.Bone[]
}

/**
 * 怪兽 3D 模型与动作驱动器（兼容罗马字/日文 MMD 骨骼及静态模型）
 */
export class KaijuController {
  public readonly root = new THREE.Group()
  private model: THREE.Object3D | null = null
  private spec: MonsterSpec | null = null
  private rig: MonsterRig | null = null
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private meshes: THREE.Mesh[] = []
  private originalEmissives = new Map<THREE.Material, { color: number; intensity: number }>()

  public readonly encounter = new KaijuEncounter()
  private get state() { return this.encounter.state }
  private get stateTime() { return this.encounter.time }
  private get currentAttack() { return this.encounter.attack }
  public currentX = 0
  public currentZ = -6
  private recoilSide = 0
  public hitFlash = 0
  private readonly upperDirection = new THREE.Vector3()
  private readonly foreDirection = new THREE.Vector3()
  private readonly restDirection = new THREE.Vector3()
  private readonly shoulderPoint = new THREE.Vector3()
  private readonly parentInverse = new THREE.Matrix4()
  private readonly alignment = new THREE.Quaternion()
  private stepPhase = 0
  private patrolPhase = 0
  private modelHeight = 17
  private lungeOffsetZ = 0

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'KaijuRoot'
    this.scene.add(this.root)
  }

  public async spawn(loader: GLTFLoader, spec: MonsterSpec): Promise<void> {
    this.clearCurrentModel()
    this.spec = spec
    const gltf = await loader.loadAsync(spec.modelUrl)
    const model = gltf.scene
    this.model = model

    // 计算包围盒，归一化高度并让脚底贴齐地面 y = 0
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    const rawHeight = Math.max(0.001, box.max.y - box.min.y)
    const center = box.getCenter(new THREE.Vector3())
    const scale = spec.targetHeight / rawHeight
    model.scale.multiplyScalar(scale)
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
    if (spec.facingOffsetY) {
      model.rotation.y = spec.facingOffsetY
    }

    this.root.position.set(0, 0, 0)
    this.root.rotation.set(0, 0, 0)
    this.root.scale.setScalar(1)
    this.root.add(model)
    this.root.updateMatrixWorld(true)

    const scaledBox = new THREE.Box3().setFromObject(model)
    this.modelHeight = Math.max(8, scaledBox.max.y - scaledBox.min.y)

    // 收集骨骼与材质
    const nodeMap = new Map<string, THREE.Bone>()
    const tailBones: THREE.Bone[] = []
    const tentacleBones: THREE.Bone[] = []

    model.traverse((node) => {
      if ((node as THREE.Bone).isBone) {
        const bone = node as THREE.Bone
        nodeMap.set(normalizeBoneKey(bone.name), bone)
        this.restQuats.set(bone, bone.quaternion.clone())
        if (/^(tail|尻尾|しっぽ)\d*$/i.test(bone.name)) {
          tailBones.push(bone)
        }
        if (/^tentacle\d*\.[LR]$/i.test(bone.name)) {
          tentacleBones.push(bone)
        }
      }
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        this.meshes.push(mesh)
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          if (m instanceof THREE.MeshStandardMaterial) {
            this.originalEmissives.set(m, {
              color: m.emissive.getHex(),
              intensity: m.emissiveIntensity,
            })
            // 提升暗色怪兽在晴空下的层次辨识度
            m.roughness = Math.max(0.45, m.roughness)
          }
        }
      }
    })

    const pick = (...names: string[]): THREE.Bone | null => {
      for (const n of names) {
        const found = nodeMap.get(normalizeBoneKey(n))
        if (found) return found
      }
      return null
    }

    this.rig = {
      hips: pick('KOSHI', 'センター', '下半身'),
      chest: pick('MUNE', '上半身2', '上半身'),
      head: pick('ATAMA', 'KAO', '頭', 'KUBI', '首'),
      armL: pick('L_ZYOUWAN', '腕.L', '腕L'),
      armR: pick('R_ZYOUWAN', '腕.R', '腕R'),
      foreL: pick('L_UDE', 'ひじ.L', '腕3.L', '腕2.L'),
      foreR: pick('R_UDE', 'ひじ.R', '腕3.R', '腕2.R'),
      jaw: pick('jaw', 'lowerjaw'),
      handL: pick('L_TE', '手首.L'),
      handR: pick('R_TE', '手首.R'),
      clawL: pick('L_TUME', 'pincer.L'),
      clawR: pick('R_TUME', 'pincer.R'),
      thighL: pick('L_MOMO', 'L_Thigh', '足.L'),
      thighR: pick('R_MOMO', 'R_Thigh', '足.R'),
      shinL: pick('L_SUNE', 'L_Leg', 'ひざ.L'),
      shinR: pick('R_SUNE', 'R_Leg', 'ひざ.R'),
      tail: tailBones,
      tentacles: tentacleBones,
    }

    this.currentX = 0
    this.currentZ = spec.baseZ
    this.lungeOffsetZ = 0
    this.hitFlash = 0
    this.patrolPhase = 0
    this.stepPhase = 0
    this.encounter.reset()
    this.root.visible = true
    this.root.scale.setScalar(1)
    this.root.position.set(0, 18, spec.baseZ - 14)
    this.root.rotation.set(0, 0, 0)
  }

  public clearCurrentModel() {
    if (this.model) {
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
    }
    this.restQuats.clear()
    this.meshes = []
    this.originalEmissives.clear()
    this.rig = null
  }

  public triggerHitFlash(strength = 1, side?: 'left' | 'right') {
    this.recoilSide = side === 'left' ? 1 : side === 'right' ? -1 : 0
    this.hitFlash = Math.min(1, Math.max(this.hitFlash, strength))
  }

  /** 获取怪兽胸口受击中心世界坐标（用于光线、光轮、拳风锁敌命中点） */
  public getTargetCenter(): THREE.Vector3 {
    return new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.modelHeight * 0.56,
      this.root.position.z + 2.2,
    )
  }

  /** 获取怪兽发射火球或暗黑光线的世界发射点 */
  public getAttackEmitOrigin(): THREE.Vector3 {
    if (this.rig?.head) {
      this.rig.head.updateWorldMatrix(true, false)
      const p = this.rig.head.getWorldPosition(new THREE.Vector3())
      p.z += 2.2
      return p
    }
    return new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.modelHeight * 0.72,
      this.root.position.z + 3.0,
    )
  }

  public update(dt: number, elapsedTime: number, heroX: number) {
    if (!this.model || !this.spec) return

    this.patrolPhase += dt

    // 恢复骨骼静息姿态
    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }

    // 受击闪白与蓄力发光材质反馈
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.5)
    const isWindup = this.state === 'windup'
    const windupPulse = isWindup ? 0.55 + 0.45 * Math.sin(elapsedTime * 18) : 0
    for (const [mat, orig] of this.originalEmissives) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue
      if (this.hitFlash > 0.05) {
        mat.emissive.setHex(0xffffff)
        mat.emissiveIntensity = this.hitFlash * 1.4
      } else if (isWindup) {
        mat.emissive.setHex(this.spec.accentColor)
        mat.emissiveIntensity = orig.intensity + windupPulse * 0.75
      } else {
        mat.emissive.setHex(orig.color)
        mat.emissiveIntensity = orig.intensity
      }
    }

    const baseZ = this.spec.baseZ
    let stride = 0
    let posY = 0
    let pitchX = 0
    let rollZ = 0
    let yawY = 0

    if (this.state === 'entering') {
      // 从天而降 / 大步迫近落地
      const t = Math.min(1, this.stateTime / 1.15)
      const easeOut = 1 - Math.pow(1 - t, 3)
      posY = (1 - easeOut) * 18
      this.currentZ = THREE.MathUtils.lerp(baseZ - 14, baseZ, easeOut)
      this.currentX = 0
      pitchX = (1 - easeOut) * 0.16
    } else if (this.state === 'dying') {
      // 重心先偏移，躯干随即加速倒下；触地后留在战场上。
      const t = Math.min(1, this.stateTime / 1.05)
      pitchX = -1.43 * t * t
      rollZ = 0.27 * Math.sin(t * Math.PI / 2)
      posY = 0.6 * t
    } else {
      // 战斗状态下轻微威慑巡游与呼吸
      const breath = Math.sin(elapsedTime * 2.2)
      const flank = this.spec.id === 'baltan' ? 5.5 : this.spec.id === 'ganq' ? 4 : 2.2
      const stalkingX = heroX * 0.55 + Math.cos(this.patrolPhase * 0.48) * flank
      const targetPatrolX = this.state === 'attack' || this.state === 'windup'
        ? this.encounter.targetX : this.state === 'idle' ? stalkingX : this.currentX
      const dx = (targetPatrolX - this.currentX) * (1 - Math.exp(-dt * 2.5))
      this.currentX += dx
      this.stepPhase += Math.abs(dx) * 1.85
      stride = Math.min(1, Math.abs(dx) / (dt * 2.8))
      posY = this.spec.isStaticMesh ? Math.sin(elapsedTime * 2.4) * 0.55 + 0.3 : Math.abs(breath) * 0.18
      yawY = Math.atan2(heroX - this.currentX, 20 - this.currentZ)

      if (this.state === 'hit') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.38) * Math.PI)
        pitchX = -0.22 * p
        this.lungeOffsetZ = -2.2 * p
        rollZ = Math.sin(this.stateTime * 35) * 0.08 * p
      } else if (this.state === 'staggered' || this.state === 'recovering') {
        const broken = this.state === 'staggered'
        const duration = broken ? 1.55 : 0.85
        const bend = Math.sin(Math.PI * Math.min(1, this.stateTime / duration)) ** 0.55
        pitchX = (broken ? 0.52 : 0.25) * bend
        rollZ = (broken ? 0.17 : -0.08) * bend
        posY -= bend * (broken ? 1.6 : 0.55)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'roaring' || this.state === 'guarding') {
        const roar = this.state === 'roaring'
        const lift = Math.sin(Math.PI * Math.min(1, this.stateTime / (roar ? 1.1 : 1.4)))
        pitchX = (roar ? -0.32 : 0.2) * lift
        posY += lift * (roar ? 0.65 : -0.6)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'windup') {
        // 蓄力后仰准备攻击
        const p = Math.min(1, this.stateTime / WINDUP_TIME)
        pitchX = -0.18 * p
        this.lungeOffsetZ = -1.8 * p
        rollZ = Math.sin(elapsedTime * 22) * 0.04 * p
      } else if (this.state === 'attack') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.65) * Math.PI)
        if (this.currentAttack === 'melee') {
          // 突进重击到迪迦身前再弹回
          this.lungeOffsetZ = p * 14.5
          pitchX = p * 0.28
        } else {
          // 吐火球/发射光线时胸口前挺
          this.lungeOffsetZ = p * 3.5
          pitchX = p * 0.14
        }
      } else {
        this.lungeOffsetZ += (0 - this.lungeOffsetZ) * Math.min(1, dt * 6)
      }
      this.currentZ = baseZ + this.lungeOffsetZ
    }

    this.root.position.set(this.currentX, posY, this.currentZ)
    this.root.rotation.set(pitchX, yawY + this.recoilSide * this.hitFlash * 0.22, rollZ + this.recoilSide * this.hitFlash * 0.12)

    // 骨骼级呼吸、手臂挥击、触手与尾巴柔性摆动
    if (this.rig) {
      const breath = Math.sin(elapsedTime * 2.4)
      if (this.rig.chest) {
        this.rig.chest.rotation.x += breath * 0.045
      }
      if (this.rig.head) {
        this.rig.head.rotation.y += Math.sin(elapsedTime * 1.4) * 0.09
      }

      // 步幅由实际横移距离决定。守势屈膝下沉，失衡时一侧膝盖让步。
      const step = Math.sin(this.stepPhase) * stride
      const crouch = this.state === 'staggered' ? 0.52 : this.state === 'guarding' ? 0.32 : 0.12
      if (this.rig.thighL) this.rig.thighL.rotation.x += crouch + step * 0.28
      if (this.rig.thighR) this.rig.thighR.rotation.x += crouch - step * 0.28
      if (this.rig.shinL) this.rig.shinL.rotation.x -= crouch + Math.max(0, step) * 0.44
      if (this.rig.shinR) this.rig.shinR.rotation.x -= crouch + Math.max(0, -step) * 0.44
      const open = this.state === 'roaring' ? Math.sin(Math.PI * this.stateTime / 1.1) : 0
      if (this.rig.jaw) this.rig.jaw.rotation.x += open * 0.55
      const pincers = this.state === 'windup' ? this.stateTime / WINDUP_TIME : open
      if (this.rig.clawL) this.rig.clawL.rotation.z += pincers * 0.55
      if (this.rig.clawR) this.rig.clawR.rotation.z -= pincers * 0.55

      // 从肩、肘、腕真实位置求出骨段方向，各套模型的本地旋转轴并不相同。
      this.poseArm(this.rig.armL, this.rig.foreL, this.rig.handL, 1, breath)
      this.poseArm(this.rig.armR, this.rig.foreR, this.rig.handR, -1, breath)

      // 尾巴与加坦杰厄触手柔性波动
      this.rig.tail.forEach((b, idx) => {
        b.rotation.y += Math.sin(elapsedTime * 2.2 - idx * 0.45) * (0.04 + idx * 0.012)
      })
      this.rig.tentacles.forEach((b, idx) => {
        b.rotation.z += Math.sin(elapsedTime * 3.1 + idx * 0.6) * 0.09
        b.rotation.x += Math.cos(elapsedTime * 2.5 + idx * 0.4) * 0.07
      })
    }

    this.root.updateMatrixWorld(true)
  }
  private poseArm(arm: THREE.Bone | null, fore: THREE.Bone | null, hand: THREE.Bone | null, side: number, breath: number) {
    if (!arm || !fore || !hand) return
    const upper = this.upperDirection.set(side * 0.58, -0.74, 0.32)
    const lower = this.foreDirection.set(-side * 0.22, 0.35 + breath * 0.10, 0.96)
    if (this.state === 'guarding') {
      upper.set(side * 0.37, -0.45, 0.82)
      lower.set(-side * 0.6, 0.8, 0.15)
    } else if (this.state === 'windup') {
      const p = Math.min(1, this.stateTime / WINDUP_TIME)
      if (this.currentAttack !== 'melee' || side > 0) {
        upper.y += p * 0.8
        upper.z -= p * 0.75
        lower.y += p * 0.65
      }
    } else if (this.state === 'attack') {
      const p = Math.sin(Math.min(1, this.stateTime / 0.65) * Math.PI)
      if (this.currentAttack !== 'melee' || side > 0) {
        upper.set(side * (0.58 - p * 0.46), -0.74 + p * 0.87, 0.32 + p)
        lower.set(-side * 0.12, 0.35 * (1 - p), 1)
      }
    } else if (this.state === 'roaring') {
      const p = Math.sin(Math.PI * this.stateTime / 1.1)
      upper.y += p * 1.35
      lower.set(side * 0.6, 0.86, 0.35)
    } else if (this.state === 'staggered' || this.state === 'dying') {
      lower.set(side * 0.28, -0.8, 0.37)
    }
    this.aimSegment(arm, fore, upper)
    this.aimSegment(fore, hand, lower)
  }

  private aimSegment(bone: THREE.Bone, tip: THREE.Bone, direction: THREE.Vector3) {
    const parent = bone.parent!
    bone.getWorldPosition(this.shoulderPoint)
    tip.getWorldPosition(this.restDirection).sub(this.shoulderPoint)
    if (this.restDirection.lengthSq() < 1e-8) return
    this.parentInverse.copy(parent.matrixWorld).invert()
    this.restDirection.transformDirection(this.parentInverse)
    direction.transformDirection(this.root.matrixWorld).transformDirection(this.parentInverse)
    bone.quaternion.premultiply(this.alignment.setFromUnitVectors(this.restDirection, direction))
  }

}
