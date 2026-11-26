import * as THREE from 'three'
import { releaseModel } from './releaseModel'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KaijuEncounter, WINDUP_TIME } from './encounter'
import type { MonsterSpec } from './types'

export const MONSTER_WAVES: MonsterSpec[] = [
  {
    id: 'gomora-mecha',
    modelUrl: '/models/ultraman/gomora-mecha.glb',
    maxHp: 1100,
    targetHeight: 16.8,
    baseZ: -1.4,
    accentColor: 0xff5a2c,
    attacks: ['melee', 'fireball', 'dark-beam'],
    attackDamage: 14,
    attackInterval: 4.0,
    defaultTheme: 'city',
    facingOffsetY: 0,
  },
  {
    id: 'baltan',
    modelUrl: '/models/ultraman/baltan.glb',
    maxHp: 1240,
    targetHeight: 16.0,
    baseZ: -1.4,
    accentColor: 0xff6b35,
    attacks: ['fireball', 'melee'],
    attackDamage: 15,
    attackInterval: 3.9,
    defaultTheme: 'seaside',
    facingOffsetY: 0,
  },
  {
    id: 'zetton',
    modelUrl: '/models/ultraman/zetton.glb',
    maxHp: 1420,
    targetHeight: 17.2,
    baseZ: -1.6,
    accentColor: 0xff9f1c,
    attacks: ['fireball', 'melee', 'dark-beam'],
    attackDamage: 17,
    attackInterval: 3.7,
    defaultTheme: 'city',
    facingOffsetY: 0,
  },
  {
    id: 'ganq',
    modelUrl: '/models/ultraman/ganq.glb',
    maxHp: 1580,
    targetHeight: 16.8,
    baseZ: -1.8,
    accentColor: 0xb048ff,
    attacks: ['fireball', 'dark-beam'],
    attackDamage: 18,
    attackInterval: 3.6,
    defaultTheme: 'mountain',
    isStaticMesh: true,
    facingOffsetY: 0,
  },
  {
    id: 'gatanothor',
    modelUrl: '/models/ultraman/gatanothor.glb',
    maxHp: 1860,
    targetHeight: 19.2,
    baseZ: -2.4,
    accentColor: 0xa855f7,
    attacks: ['dark-beam', 'fireball', 'melee'],
    attackDamage: 20,
    attackInterval: 3.4,
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
 * 怪兽 3D 模型与特摄物理光效控制器：
 * - Fresnel 轮廓辉光 Shader（含 pow 安全下限防 NaN 污染 Bloom）
 * - 支持近身肉搏、远程高台炮击、正面角力僵持、被过肩摔抛飞与残血终结受击演出
 * - 全骨骼四元数阻尼插值，彻底消除状态切换瞬移僵硬感
 */
export class KaijuController {
  public readonly root = new THREE.Group()
  private model: THREE.Object3D | null = null
  private loadGeneration = 0
  private spec: MonsterSpec | null = null
  private rig: MonsterRig | null = null
  private restQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private smoothQuats = new Map<THREE.Bone, THREE.Quaternion>()
  private meshes: THREE.Mesh[] = []

  // 共享着色器 Uniform（驱动轮廓能量气场与受击橙白闪光，不刷白纹理）
  private readonly uRimColor = { value: new THREE.Color(0xff6b35) }
  private readonly uRimStrength = { value: 0 }
  private readonly uHitFlash = { value: 0 }

  public readonly encounter = new KaijuEncounter()
  private get state() {
    return this.encounter.state
  }
  private get stateTime() {
    return this.encounter.time
  }
  private get currentAttack() {
    return this.encounter.attack
  }
  public currentX = 0
  public currentZ = -1.6
  public stageTargetZ: number | null = null
  public stageTargetX: number | null = null
  private smoothStageZ = -1.6
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
  /** 怪兽归一化缩放后向 +Z（英雄方向）探出的真实物理前端距离，用于全链路防穿模 */
  public frontExtentZ = 3.8
  private lungeOffsetZ = 0
  private heroAnchorZ = 8.6

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'KaijuRoot'
    this.scene.add(this.root)
  }

  public setStageAnchor(targetZ: number | null, heroZ = 8.4, targetX: number | null = null) {
    this.stageTargetZ = targetZ
    this.heroAnchorZ = heroZ
    this.stageTargetX = targetX
  }

  /** 电影切场时瞬间对齐怪兽世界站位，消除过场瞬间主体落在画外导致的空镜头 */
  public snapToPosition(x: number, z: number) {
    this.currentX = x
    this.currentZ = z
    this.smoothStageZ = z
    this.stageTargetZ = z
    this.stageTargetX = x
    this.lungeOffsetZ = 0
    this.root.position.set(x, 0, z)
    this.root.updateMatrixWorld(true)
  }

  public async spawn(loader: GLTFLoader, spec: MonsterSpec): Promise<void> {
    this.clearCurrentModel()
    const generation = this.loadGeneration
    this.spec = spec
    this.uRimColor.value.setHex(spec.accentColor)
    this.uRimStrength.value = 0
    this.uHitFlash.value = 0

    const gltf = await loader.loadAsync(spec.modelUrl)
    const model = gltf.scene
    if (generation !== this.loadGeneration) {
      releaseModel(model)
      return
    }
    this.model = model

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

    const nodeMap = new Map<string, THREE.Bone>()
    const tailBones: THREE.Bone[] = []
    const tentacleBones: THREE.Bone[] = []

    model.traverse((node) => {
      if ((node as THREE.Bone).isBone) {
        const bone = node as THREE.Bone
        nodeMap.set(normalizeBoneKey(bone.name), bone)
        this.restQuats.set(bone, bone.quaternion.clone())
        this.smoothQuats.set(bone, bone.quaternion.clone())
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
            m.roughness = THREE.MathUtils.clamp(m.roughness, 0.38, 0.78)
            m.metalness = Math.min(0.45, m.metalness)
            this.injectKaijuRimShader(m)
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

    // 关键防穿模归中：长尾怪兽（如机械哥莫拉）用 Box3 居中会把躯干大幅推向 +Z；
    // 改为按真实躯干骨骼（hips/chest）将身体重心精准对齐到 root 原点 Z=0，再实测真实最前沿距离！
    const torsoAnchor = this.rig.hips ?? this.rig.chest
    if (torsoAnchor) {
      this.root.updateMatrixWorld(true)
      const anchorWorld = torsoAnchor.getWorldPosition(new THREE.Vector3())
      model.position.x -= anchorWorld.x
      model.position.z -= anchorWorld.z
      this.root.updateMatrixWorld(true)
    }

    // 实测归中后怪兽面向奥特曼侧（+Z）的真实无截断最前沿距离（综合 Box3 与头/爪骨骼位置）
    const alignedBox = new THREE.Box3().setFromObject(model)
    let measuredFrontZ = alignedBox.max.z
    for (const b of [this.rig.head, this.rig.handL, this.rig.handR, this.rig.clawL, this.rig.clawR]) {
      if (!b) continue
      const wz = b.getWorldPosition(new THREE.Vector3()).z + 1.6
      if (wz > measuredFrontZ) measuredFrontZ = wz
    }
    this.frontExtentZ = Math.max(3.2, measuredFrontZ)

    this.currentX = 0
    this.currentZ = spec.baseZ
    this.smoothStageZ = spec.baseZ
    this.stageTargetZ = null
    this.stageTargetX = null
    this.lungeOffsetZ = 0
    this.hitFlash = 0
    this.patrolPhase = 0
    this.stepPhase = 0
    this.encounter.reset()
    this.root.visible = true
    this.root.scale.setScalar(1)
    this.root.position.set(0, 18, spec.baseZ - 12)
    this.root.rotation.set(0, 0, 0)
  }

  private injectKaijuRimShader(mat: THREE.MeshStandardMaterial) {
    mat.customProgramCacheKey = () => 'kaiju-fresnel-rim-v2'
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = this.uRimColor
      shader.uniforms.uRimStrength = this.uRimStrength
      shader.uniforms.uHitFlash = this.uHitFlash
      shader.fragmentShader =
        'uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uHitFlash;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `
          vec3 kViewDir = normalize( vViewPosition + vec3( 0.0001 ) );
          float kNdotV = clamp( abs( dot( normalize( normal ), kViewDir ) ), 0.0, 1.0 );
          float kFresnel = pow( max( 1.0 - kNdotV, 0.0001 ), 2.2 );
          outgoingLight += uRimColor * ( kFresnel * uRimStrength );
          outgoingLight = mix(
            outgoingLight,
            outgoingLight * 1.45 + vec3( 0.58, 0.36, 0.24 ) * ( 0.28 + 0.72 * kFresnel ),
            uHitFlash
          );
          #include <opaque_fragment>
          `,
        )
    }
  }

  public clearCurrentModel() {
    this.loadGeneration++
    if (this.model) {
      this.root.remove(this.model)
      releaseModel(this.model)
      this.model = null
    }
    this.restQuats.clear()
    this.smoothQuats.clear()
    this.meshes = []
    this.rig = null
  }

  public triggerHitFlash(strength = 1, side?: 'left' | 'right') {
    this.recoilSide = side === 'left' ? 1 : side === 'right' ? -1 : 0
    this.hitFlash = Math.min(1, Math.max(this.hitFlash, strength))
  }

  /** 返回当前帧怪兽面向英雄一侧的实时最前沿世界 Z 坐标（同时取真实骨骼位置与包围盒最大值，杜绝任何穿模） */
  public getFrontSurfaceZ(): number {
    const pitchForward =
      this.root.rotation.x > 0
        ? Math.sin(this.root.rotation.x) * this.modelHeight * 0.34
        : 0
    let frontZ = this.root.position.z + this.frontExtentZ + pitchForward
    if (this.rig) {
      const tmp = new THREE.Vector3()
      for (const b of [this.rig.head, this.rig.handL, this.rig.handR, this.rig.clawL, this.rig.clawR]) {
        if (!b) continue
        b.getWorldPosition(tmp)
        if (tmp.z + 1.5 > frontZ) frontZ = tmp.z + 1.5
      }
    }
    return frontZ
  }

  /** 获取怪兽胸口受击中心世界坐标 */
  public getTargetCenter(): THREE.Vector3 {
    return new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.modelHeight * 0.56,
      this.root.position.z + 2.0,
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
      this.root.position.y + this.modelHeight * 0.68,
      this.root.position.z + 2.6,
    )
  }

  public update(dt: number, elapsedTime: number, heroX: number) {
    if (!this.model || !this.spec) return

    this.patrolPhase += dt

    for (const [bone, quat] of this.restQuats) {
      bone.quaternion.copy(quat)
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 5.0)
    this.uHitFlash.value = this.hitFlash
    this.uRimColor.value.setHex(this.spec.accentColor)

    if (this.state === 'windup') {
      const pulse = 0.55 + 0.45 * Math.sin(elapsedTime * 22)
      this.uRimColor.value.setHex(0xff521b)
      this.uRimStrength.value = 1.45 + pulse * 1.85
    } else if (this.state === 'finisher-hit') {
      const pulse = 0.5 + 0.5 * Math.sin(elapsedTime * 36)
      this.uRimColor.value.setHex(0xff2e4c)
      this.uRimStrength.value = 2.1 + pulse * 1.4
    } else if (this.state === 'grapple') {
      this.uRimColor.value.setHex(0xff6b2b)
      this.uRimStrength.value = 1.15 + Math.sin(elapsedTime * 18) * 0.35
    } else if (this.state === 'roaring' || this.encounter.enraged) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsedTime * 8)
      this.uRimStrength.value = this.state === 'roaring' ? 2.2 : 0.42 + pulse * 0.48
    } else if (this.state === 'guarding') {
      this.uRimColor.value.setHex(0x60a5fa)
      this.uRimStrength.value = 1.4
    } else if (this.state === 'stunned') {
      this.uRimColor.value.setHex(0xfacc15)
      this.uRimStrength.value = 0.65 + Math.sin(elapsedTime * 12) * 0.35
    } else {
      this.uRimStrength.value = 0.24
    }

    const desiredBaseZ = this.stageTargetZ ?? this.spec.baseZ
    this.smoothStageZ += (desiredBaseZ - this.smoothStageZ) * (1 - Math.exp(-dt * 5.5))
    const baseZ = this.smoothStageZ

    let stride = 0
    let posY = 0
    let pitchX = 0
    let rollZ = 0
    let yawY = 0

    if (this.state === 'entering') {
      const t = Math.min(1, this.stateTime / 1.15)
      const easeOut = 1 - Math.pow(1 - t, 3)
      posY = (1 - easeOut) * 18
      this.currentZ = THREE.MathUtils.lerp(baseZ - 12, baseZ, easeOut)
      this.currentX = 0
      pitchX = (1 - easeOut) * 0.16
    } else if (this.state === 'dying') {
      const t = Math.min(1, this.stateTime / 1.05)
      pitchX = -1.43 * t * t
      rollZ = 0.27 * Math.sin((t * Math.PI) / 2)
      posY = 0.6 * t
    } else if (this.state === 'grapple') {
      // 正面贴身角力抵推：控制温和前倾角防止头角越界穿模，双爪与奥特曼双掌精准对抵
      const targetX = this.stageTargetX ?? heroX
      this.currentX += (targetX - this.currentX) * (1 - Math.exp(-dt * 12))
      const tremble = Math.sin(elapsedTime * 34) * 0.035
      this.lungeOffsetZ += (0 - this.lungeOffsetZ) * (1 - Math.exp(-dt * 12))
      this.currentZ = baseZ + Math.sin(elapsedTime * 22) * 0.12
      posY = Math.abs(Math.sin(elapsedTime * 14)) * 0.18
      pitchX = 0.12 + Math.sin(elapsedTime * 16) * 0.03
      rollZ = tremble
      yawY = 0
    } else if (this.state === 'thrown') {
      // 被奥特曼霸气过肩摔砸飞到后方废墟（视频 2 1:12-1:15）
      const t = Math.min(1, this.stateTime / 1.05)
      const fly = Math.min(1, t / 0.72)
      const easeOut = 1 - Math.pow(1 - fly, 2.5)
      const bounce = t > 0.72 ? Math.sin(((t - 0.72) / 0.28) * Math.PI) * 1.4 : 0
      this.currentZ = THREE.MathUtils.lerp(baseZ, baseZ - 14.5, easeOut)
      posY = Math.sin(fly * Math.PI) * 7.8 + bounce
      pitchX = -0.95 * easeOut - Math.sin(fly * Math.PI) * 0.55
      rollZ = 0.32 * easeOut
      yawY = 0.25 * easeOut
    } else if (this.state === 'stunned') {
      const sway = Math.sin(elapsedTime * 4.2)
      this.lungeOffsetZ *= Math.exp(-6 * dt)
      this.currentZ = baseZ + this.lungeOffsetZ
      pitchX = 0.36 + sway * 0.06
      rollZ = sway * 0.14
      posY = -1.25
      yawY = Math.atan2(heroX - this.currentX, Math.max(4, this.heroAnchorZ - this.currentZ))
    } else if (this.state === 'finisher-hit') {
      const shake = Math.sin(elapsedTime * 42)
      this.lungeOffsetZ = Math.max(-5.5, this.lungeOffsetZ - dt * 2.2)
      this.currentZ = baseZ + this.lungeOffsetZ
      pitchX = -0.34 + shake * 0.08
      rollZ = Math.cos(elapsedTime * 37) * 0.16
      posY = 0.35 + Math.abs(shake) * 0.35
      yawY = Math.atan2(heroX - this.currentX, Math.max(4, this.heroAnchorZ - this.currentZ))
    } else {
      const breath = Math.sin(elapsedTime * 2.4)
      const flank = this.stageTargetX !== null ? 0 : this.spec.id === 'baltan' ? 3.2 : 1.6
      const stalkingX =
        this.stageTargetX !== null
          ? this.stageTargetX
          : heroX * 0.48 + Math.cos(this.patrolPhase * 0.52) * flank
      const targetPatrolX =
        this.state === 'attack' || this.state === 'windup'
          ? this.stageTargetX !== null
            ? this.stageTargetX
            : this.encounter.targetX * 0.55
          : this.state === 'idle'
            ? stalkingX
            : this.currentX
      const dx = (targetPatrolX - this.currentX) * (1 - Math.exp(-dt * 3.0))
      this.currentX += dx
      this.stepPhase += Math.abs(dx) * 1.85
      stride = Math.min(1, Math.abs(dx) / Math.max(1e-4, dt * 2.8))
      posY = this.spec.isStaticMesh
        ? Math.sin(elapsedTime * 2.4) * 0.55 + 0.3
        : Math.abs(breath) * 0.2
      yawY = Math.atan2(heroX - this.currentX, Math.max(4.5, this.heroAnchorZ - this.currentZ))

      if (this.state === 'hit') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.34) * Math.PI)
        pitchX = -0.32 * p
        this.lungeOffsetZ = -2.2 * p
        rollZ = Math.sin(this.stateTime * 38) * 0.12 * p
      } else if (this.state === 'staggered' || this.state === 'recovering') {
        const broken = this.state === 'staggered'
        const duration = broken ? 1.65 : 0.78
        const bend = Math.sin(Math.PI * Math.min(1, this.stateTime / duration)) ** 0.55
        pitchX = (broken ? 0.54 : 0.24) * bend
        rollZ = (broken ? 0.18 : -0.08) * bend
        posY -= bend * (broken ? 1.6 : 0.5)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'roaring' || this.state === 'guarding') {
        const roar = this.state === 'roaring'
        const lift = Math.sin(Math.PI * Math.min(1, this.stateTime / (roar ? 1.05 : 1.35)))
        pitchX = (roar ? -0.34 : 0.2) * lift
        posY += lift * (roar ? 0.65 : -0.6)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'windup') {
        const p = Math.min(1, this.stateTime / WINDUP_TIME)
        pitchX = -0.22 * p
        this.lungeOffsetZ = -1.5 * p
        rollZ = Math.sin(elapsedTime * 24) * 0.05 * p
      } else if (this.state === 'attack') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.62) * Math.PI)
        if (this.currentAttack === 'melee') {
          // 按怪兽真实前探深度计算安全扑击止点，利爪停在英雄身前护盾面外，绝对零穿模！
          const maxSafeZ = this.heroAnchorZ - (this.frontExtentZ + 3.6)
          const meleeReach = Math.max(1.2, Math.min(4.8, maxSafeZ - baseZ))
          this.lungeOffsetZ = p * meleeReach
          pitchX = p * 0.2
        } else {
          this.lungeOffsetZ = p * 1.6
          pitchX = p * 0.12
        }
      } else {
        this.lungeOffsetZ += (0 - this.lungeOffsetZ) * Math.min(1, dt * 6.5)
      }
      this.currentZ = baseZ + this.lungeOffsetZ
    }

    this.root.position.set(this.currentX, posY, this.currentZ)
    this.root.rotation.set(
      pitchX,
      yawY + this.recoilSide * this.hitFlash * 0.28,
      rollZ + this.recoilSide * this.hitFlash * 0.16,
    )

    if (this.rig) {
      const breath = Math.sin(elapsedTime * 2.4)
      if (this.rig.chest) {
        this.rig.chest.rotation.x += breath * 0.045
      }
      if (this.rig.head) {
        this.rig.head.rotation.y += Math.sin(elapsedTime * 1.4) * 0.09
      }

      const step = Math.sin(this.stepPhase) * stride
      const crouch =
        this.state === 'staggered' || this.state === 'stunned'
          ? 0.52
          : this.state === 'guarding' || this.state === 'grapple'
            ? 0.34
            : 0.12
      if (this.rig.thighL) this.rig.thighL.rotation.x += crouch + step * 0.28
      if (this.rig.thighR) this.rig.thighR.rotation.x += crouch - step * 0.28
      if (this.rig.shinL) this.rig.shinL.rotation.x -= crouch + Math.max(0, step) * 0.44
      if (this.rig.shinR) this.rig.shinR.rotation.x -= crouch + Math.max(0, -step) * 0.44

      const open =
        this.state === 'roaring'
          ? Math.sin((Math.PI * this.stateTime) / 1.05)
          : this.state === 'grapple' || this.state === 'finisher-hit'
            ? 0.75 + 0.25 * Math.sin(elapsedTime * 18)
            : 0
      if (this.rig.jaw) this.rig.jaw.rotation.x += open * 0.55
      const pincers = this.state === 'windup' ? this.stateTime / WINDUP_TIME : open
      if (this.rig.clawL) this.rig.clawL.rotation.z += pincers * 0.55
      if (this.rig.clawR) this.rig.clawR.rotation.z -= pincers * 0.55

      this.poseArm(this.rig.armL, this.rig.foreL, this.rig.handL, 1, breath)
      this.poseArm(this.rig.armR, this.rig.foreR, this.rig.handR, -1, breath)

      this.rig.tail.forEach((b, idx) => {
        b.rotation.y += Math.sin(elapsedTime * 2.2 - idx * 0.45) * (0.04 + idx * 0.012)
      })
      this.rig.tentacles.forEach((b, idx) => {
        b.rotation.z += Math.sin(elapsedTime * 3.1 + idx * 0.6) * 0.09
        b.rotation.x += Math.cos(elapsedTime * 2.5 + idx * 0.4) * 0.07
      })

      // 骨骼帧间四元数平滑阻尼，消除状态切换硬跳
      const blend = 1 - Math.exp(-dt * 18)
      for (const [bone, prevQ] of this.smoothQuats) {
        prevQ.slerp(bone.quaternion, blend)
        bone.quaternion.copy(prevQ)
      }
    }

    this.root.updateMatrixWorld(true)
  }

  private poseArm(
    arm: THREE.Bone | null,
    fore: THREE.Bone | null,
    hand: THREE.Bone | null,
    side: number,
    breath: number,
  ) {
    if (!arm || !fore || !hand) return
    const upper = this.upperDirection.set(side * 0.58, -0.74, 0.32)
    const lower = this.foreDirection.set(-side * 0.22, 0.35 + breath * 0.1, 0.96)
    if (this.state === 'grapple') {
      // 双爪前倾下压，精准对抵奥特曼胸前双掌高度形成正面角力胶着
      upper.set(side * 0.24, -0.16, 0.96)
      lower.set(side * 0.08, -0.18, 0.98)
    } else if (this.state === 'thrown' || this.state === 'finisher-hit') {
      upper.set(side * 0.85, 0.48, 0.22)
      lower.set(side * 0.72, 0.62, 0.32)
    } else if (this.state === 'guarding') {
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
      const p = Math.sin(Math.min(1, this.stateTime / 0.62) * Math.PI)
      if (this.currentAttack !== 'melee' || side > 0) {
        upper.set(side * (0.58 - p * 0.46), -0.74 + p * 0.87, 0.32 + p)
        lower.set(-side * 0.12, 0.35 * (1 - p), 1)
      }
    } else if (this.state === 'roaring') {
      const p = Math.sin((Math.PI * this.stateTime) / 1.05)
      upper.y += p * 1.35
      lower.set(side * 0.6, 0.86, 0.35)
    } else if (this.state === 'staggered' || this.state === 'stunned' || this.state === 'dying') {
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
