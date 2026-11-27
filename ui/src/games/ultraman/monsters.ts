import * as THREE from 'three'
import { releaseModel } from './releaseModel'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KaijuEncounter, WINDUP_TIME } from './encounter'
import type { MonsterSpec, StrikeHeight } from './types'

export const MONSTER_WAVES: MonsterSpec[] = [
  {
    id: 'gomora-mecha',
    modelUrl: '/models/ultraman/gomora-mecha.glb',
    maxHp: 1120,
    targetHeight: 16.8,
    baseZ: -1.2,
    accentColor: 0xff5a2c,
    attacks: ['melee', 'charge', 'fireball', 'melee-low', 'dark-beam'],
    attackDamage: 14,
    attackInterval: 3.8,
    defaultTheme: 'city',
    armorMaterial: 'metal',
    facingOffsetY: 0,
  },
  {
    id: 'baltan',
    modelUrl: '/models/ultraman/baltan.glb',
    maxHp: 1260,
    targetHeight: 16.0,
    baseZ: -1.4,
    accentColor: 0x38bdf8,
    attacks: ['illusion', 'melee-high', 'fireball', 'melee'],
    attackDamage: 15,
    attackInterval: 3.6,
    defaultTheme: 'seaside',
    armorMaterial: 'chitin',
    facingOffsetY: 0,
  },
  {
    id: 'zetton',
    modelUrl: '/models/ultraman/zetton.glb',
    maxHp: 1480,
    targetHeight: 17.4,
    baseZ: -1.5,
    accentColor: 0xff9f1c,
    attacks: ['fireball', 'melee-high', 'melee-low', 'dark-beam'],
    attackDamage: 17,
    attackInterval: 3.4,
    defaultTheme: 'city',
    armorMaterial: 'chitin',
    facingOffsetY: 0,
  },
  {
    id: 'ganq',
    modelUrl: '/models/ultraman/ganq.glb',
    maxHp: 1620,
    targetHeight: 16.8,
    baseZ: -1.6,
    accentColor: 0xb048ff,
    attacks: ['fireball', 'melee-low', 'dark-beam', 'melee-high'],
    attackDamage: 18,
    attackInterval: 3.4,
    defaultTheme: 'mountain',
    armorMaterial: 'eldritch',
    isStaticMesh: false,
    facingOffsetY: 0,
  },
  {
    id: 'gatanothor',
    modelUrl: '/models/ultraman/gatanothor.glb',
    maxHp: 1920,
    targetHeight: 19.2,
    baseZ: -2.2,
    accentColor: 0xa855f7,
    attacks: ['melee-high', 'melee-low', 'dark-beam', 'fireball'],
    attackDamage: 20,
    attackInterval: 3.2,
    defaultTheme: 'volcano',
    armorMaterial: 'eldritch',
    facingOffsetY: 0,
  },
]

const normalizeBoneKey = (name: string) => name.replace(/[ ._-]/g, '').toLowerCase()

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
  wingsL: THREE.Bone[]
  wingsR: THREE.Bone[]
}

/**
 * 高清 5 大怪兽 3D 骨骼与特摄交互控制器：
 * - 完整兼容 5 套高清源模骨架（Bip001 / MMDCharizard / PMX 日文骨 / GanQ 21 骨）
 * - 部位+方向受击反馈（打头仰头甩脸、打胸震颤、打腿踉跄）+ 顿帧期间 48Hz 高频肉体微抖
 * - 巴尔坦三体幻影分身、海帕杰顿波状吸光护盾、加恩Q 紫瞳吸能环专属可视化
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

  // 共享着色器 Uniform（轮廓能量气场与受击闪光）
  private readonly uRimColor = { value: new THREE.Color(0xff6b35) }
  private readonly uRimStrength = { value: 0 }
  private readonly uHitFlash = { value: 0 }

  // 专属机制可视化道具：巴尔坦双幻影分身 & 杰顿/加恩Q 身前能量波形盾环
  private illusionClones: THREE.Object3D[] = []
  private readonly specialBarrierMesh: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>

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

  // 部位受击反馈与顿帧高频微抖状态
  private recoilSide = 0
  private recoilHeight: StrikeHeight = 'mid'
  private hitVibrateTime = 0
  private hitVibrateIntensity = 0
  private hitVibratePhase = 0
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
  /** 怪兽归一化缩放后向 +Z（英雄方向）探出的真实物理前端距离，用于防穿模 */
  public frontExtentZ = 3.8
  private lungeOffsetZ = 0
  private heroAnchorZ = 8.6

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'KaijuRoot'
    this.scene.add(this.root)

    // 怪兽身前波状屏障/吸能环（杰顿波状盾 / 加恩Q 紫瞳吸能漩涡）
    this.specialBarrierMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 7.6, 36),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(0x38bdf8) },
          uMode: { value: 0 }, // 0=杰顿波状向外护盾, 1=加恩Q向内吸能漩涡
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform vec3 uColor;
          uniform float uMode;
          varying vec2 vUv;
          void main() {
            vec2 q = (vUv - 0.5) * 2.0;
            float r = length(q);
            if (r > 1.0 || r < 0.08) discard;
            float dir = uMode > 0.5 ? 1.0 : -1.0;
            float wave = 0.5 + 0.5 * sin(r * 22.0 + dir * uTime * 16.0);
            float ang = atan(q.y, q.x);
            float hex = 0.72 + 0.28 * sin(ang * 6.0 + uTime * 3.0 * dir);
            float edge = smoothstep(0.12, 0.35, r) * (1.0 - smoothstep(0.78, 1.0, r));
            float rim = exp(-pow(max(abs(r - 0.88) * 18.0, 0.0001), 2.0));
            float alpha = (wave * 0.42 * hex + rim * 0.75) * edge;
            vec3 col = mix(uColor * 1.25, vec3(1.5, 1.6, 1.8), rim * 0.6);
            gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.88));
          }
        `,
      }),
    )
    this.specialBarrierMesh.visible = false
    this.root.add(this.specialBarrierMesh)
  }

  public getSpec(): MonsterSpec | null {
    return this.spec
  }

  public setStageAnchor(targetZ: number | null, heroZ = 8.4, targetX: number | null = null) {
    this.stageTargetZ = targetZ
    this.heroAnchorZ = heroZ
    this.stageTargetX = targetX
  }

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
    const wingsL: THREE.Bone[] = []
    const wingsR: THREE.Bone[] = []

    model.traverse((node) => {
      if ((node as THREE.Bone).isBone) {
        const bone = node as THREE.Bone
        nodeMap.set(normalizeBoneKey(bone.name), bone)
        this.restQuats.set(bone, bone.quaternion.clone())
        this.smoothQuats.set(bone, bone.quaternion.clone())

        if (/^(tail|尻尾|しっぽ)\d*$/i.test(bone.name)) {
          tailBones.push(bone)
        }
        if (
          /^(tentacle|L tentacle|R tentacle)/i.test(bone.name) ||
          (spec.id === 'gatanothor' && /^Bone0(18|19|20|22|26|28|30|32|33|34|35|37)/i.test(bone.name))
        ) {
          tentacleBones.push(bone)
        }
        if (/^左wing/i.test(bone.name)) wingsL.push(bone)
        if (/^右wing/i.test(bone.name)) wingsR.push(bone)
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
            m.roughness = THREE.MathUtils.clamp(m.roughness, 0.24, 0.82)
            m.metalness = Math.min(0.68, m.metalness)
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
      hips: pick('KOSHI', 'センター', '下半身', 'Bip001 Pelvis', 'center', 'lowerbody', 'all'),
      chest: pick('MUNE', '上半身2', '上半身', 'Bip001 Spine1', 'Bip001 Spine', 'upperbody', 'chest'),
      head: pick('ATAMA', 'KAO', '頭', 'Bip001 Head', 'head', 'KUBI', '首', 'Bip001 Neck', 'neck'),
      armL: pick('L_ZYOUWAN', '腕.L', '左腕', 'Bip001 L UpperArm', 'arm.L', 'L upper arm'),
      armR: pick('R_ZYOUWAN', '腕.R', '右腕', 'Bip001 R UpperArm', 'arm.R', 'R upper arm'),
      foreL: pick('L_UDE', 'ひじ.L', '左ひじ', 'Bip001 L Forearm', 'elbow.L', 'L forearm'),
      foreR: pick('R_UDE', 'ひじ.R', '右ひじ', 'Bip001 R Forearm', 'elbow.R', 'R forearm'),
      jaw: pick('jaw', 'lowerjaw'),
      handL: pick('L_TE', '手首.L', '左手首', 'Bip001 L Hand', 'wrist.L', 'L tentacle 01'),
      handR: pick('R_TE', '手首.R', '右手首', 'Bip001 R Hand', 'wrist.R', 'R tentacle 01'),
      clawL: pick('L_TUME', 'pincer.L', 'Bip001 L Finger0', 'Bip001 L Finger1'),
      clawR: pick('R_TUME', 'pincer.R', 'Bip001 R Finger0', 'Bip001 R Finger1'),
      thighL: pick('L_MOMO', 'L_Thigh', '足.L', '左足', 'Bip001 L Thigh', 'leg.L', 'L thight'),
      thighR: pick('R_MOMO', 'R_Thigh', '足.R', '右足', 'Bip001 R Thigh', 'leg.R', 'R thight'),
      shinL: pick('L_SUNE', 'L_Leg', 'ひざ.L', '左ひざ', 'Bip001 L Calf', 'knee.L', 'L calf'),
      shinR: pick('R_SUNE', 'R_Leg', 'ひざ.R', '右ひざ', 'Bip001 R Calf', 'knee.R', 'R calf'),
      tail: tailBones,
      tentacles: tentacleBones,
      wingsL,
      wingsR,
    }

    // 按真实躯干骨骼水平归中，避免长尾（哥莫拉）或大壳（加坦杰厄）把本体推偏
    const torsoAnchor = this.rig.hips ?? this.rig.chest
    if (torsoAnchor) {
      this.root.updateMatrixWorld(true)
      const anchorWorld = torsoAnchor.getWorldPosition(new THREE.Vector3())
      model.position.x -= anchorWorld.x
      model.position.z -= anchorWorld.z
      this.root.updateMatrixWorld(true)
    }

    const alignedBox = new THREE.Box3().setFromObject(model)
    let measuredFrontZ = alignedBox.max.z
    for (const b of [this.rig.head, this.rig.handL, this.rig.handR, this.rig.clawL, this.rig.clawR]) {
      if (!b) continue
      const wz = b.getWorldPosition(new THREE.Vector3()).z + 1.4
      if (wz > measuredFrontZ) measuredFrontZ = wz
    }
    this.frontExtentZ = THREE.MathUtils.clamp(measuredFrontZ, 2.8, 7.6)

    // 为巴尔坦星人预构建 2 个半透明青色幻影分身网格（仅在 illusion 状态显示）
    if (spec.id === 'baltan') {
      this.buildIllusionClones(model)
    }

    this.currentX = 0
    this.currentZ = spec.baseZ
    this.smoothStageZ = spec.baseZ
    this.stageTargetZ = null
    this.stageTargetX = null
    this.lungeOffsetZ = 0
    this.hitFlash = 0
    this.hitVibrateTime = 0
    this.patrolPhase = 0
    this.stepPhase = 0
    this.encounter.reset()
    this.root.visible = true
    this.root.scale.setScalar(1)
    this.root.position.set(0, 18, spec.baseZ - 12)
    this.root.rotation.set(0, 0, 0)
  }

  private buildIllusionClones(sourceModel: THREE.Object3D) {
    const holoMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      wireframe: false,
    })
    for (let i = 0; i < 2; i++) {
      const cloneGroup = new THREE.Group()
      sourceModel.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const srcMesh = node as THREE.Mesh
          const ghost = new THREE.Mesh(srcMesh.geometry, holoMat)
          ghost.scale.copy(sourceModel.scale)
          ghost.position.copy(sourceModel.position)
          cloneGroup.add(ghost)
        }
      })
      cloneGroup.visible = false
      this.root.add(cloneGroup)
      this.illusionClones.push(cloneGroup)
    }
  }

  private injectKaijuRimShader(mat: THREE.MeshStandardMaterial) {
    mat.customProgramCacheKey = () => 'kaiju-fresnel-rim-v3'
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
            outgoingLight * 1.45 + vec3( 0.64, 0.38, 0.24 ) * ( 0.28 + 0.72 * kFresnel ),
            uHitFlash
          );
          #include <opaque_fragment>
          `,
        )
    }
  }

  public clearCurrentModel() {
    this.loadGeneration++
    for (const c of this.illusionClones) {
      this.root.remove(c)
      c.traverse((n) => {
        if ((n as THREE.Mesh).isMesh) {
          const m = (n as THREE.Mesh).material
          if (m instanceof THREE.Material) m.dispose()
        }
      })
    }
    this.illusionClones = []
    this.specialBarrierMesh.visible = false

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

  /** 触发部位与方向差异化受击反应 + 顿帧高频微抖 */
  public triggerHitReaction(
    strength = 1,
    side?: 'left' | 'right',
    height: StrikeHeight = 'mid',
  ) {
    this.recoilSide = side === 'left' ? 1 : side === 'right' ? -1 : 0
    this.recoilHeight = height
    this.hitFlash = Math.min(1, Math.max(this.hitFlash, strength))
    this.hitVibrateTime = Math.max(this.hitVibrateTime, 0.14 + strength * 0.1)
    this.hitVibrateIntensity = Math.max(this.hitVibrateIntensity, 0.35 + strength * 0.55)
  }

  /** 兼容旧调用 */
  public triggerHitFlash(strength = 1, side?: 'left' | 'right') {
    this.triggerHitReaction(strength, side, 'mid')
  }

  /** 在顿帧（Hitstop）冻结主逻辑期间单独驱动怪兽高频肉体震颤，强化硬核实打质感 */
  public stepHitstopVibration(rawDt: number) {
    if (!this.model || this.hitVibrateTime <= 0) return
    this.hitVibrateTime = Math.max(0, this.hitVibrateTime - rawDt)
    this.hitVibratePhase += rawDt * 95
    const amp = this.hitVibrateIntensity * Math.min(1, this.hitVibrateTime * 6)
    this.root.position.x = this.currentX + Math.sin(this.hitVibratePhase) * amp
    this.root.position.z = this.currentZ + Math.cos(this.hitVibratePhase * 1.3) * amp * 0.5
    this.root.updateMatrixWorld(true)
  }

  public getFrontSurfaceZ(): number {
    const pitchForward =
      this.root.rotation.x > 0
        ? Math.sin(this.root.rotation.x) * this.modelHeight * 0.28
        : 0
    return this.root.position.z + this.frontExtentZ + pitchForward
  }

  /** 按打击高度返回胸口/头面/下盘受击靶点世界坐标 */
  public getTargetCenter(height: StrikeHeight = 'mid'): THREE.Vector3 {
    const ratio = height === 'high' ? 0.78 : height === 'low' ? 0.34 : 0.56
    return new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.modelHeight * ratio,
      this.root.position.z + Math.min(3.4, this.frontExtentZ * 0.65),
    )
  }

  public getAttackEmitOrigin(): THREE.Vector3 {
    if (this.rig?.head) {
      this.rig.head.updateWorldMatrix(true, false)
      const p = this.rig.head.getWorldPosition(new THREE.Vector3())
      p.z += 2.0
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

    this.hitFlash = Math.max(0, this.hitFlash - dt * 4.8)
    this.hitVibrateTime = Math.max(0, this.hitVibrateTime - dt)
    this.uHitFlash.value = this.hitFlash
    this.uRimColor.value.setHex(this.spec.accentColor)

    // 专属能量屏障/吸能环可视控制
    const showBarrier =
      (this.state === 'guarding' && this.spec.id === 'zetton') || this.state === 'absorbing'
    this.specialBarrierMesh.visible = showBarrier
    if (showBarrier) {
      this.specialBarrierMesh.position.set(0, this.modelHeight * 0.54, this.frontExtentZ + 0.9)
      this.specialBarrierMesh.material.uniforms.uTime!.value = elapsedTime
      const isAbsorb = this.state === 'absorbing'
      this.specialBarrierMesh.material.uniforms.uMode!.value = isAbsorb ? 1 : 0
      this.specialBarrierMesh.material.uniforms.uColor!.value.setHex(
        isAbsorb ? 0xc084fc : 0x38bdf8,
      )
    }

    // 巴尔坦三体分身幻影显隐与左右闪烁环绕
    const showIllusion = this.state === 'illusion' && this.illusionClones.length === 2
    if (showIllusion) {
      const spread = Math.min(1, this.stateTime / 0.32) * 8.4
      const phaseFlicker = 0.25 + 0.25 * Math.sin(elapsedTime * 22)
      const offsets = [-spread, spread]
      this.illusionClones.forEach((clone, idx) => {
        clone.visible = true
        clone.position.set(offsets[idx]!, Math.sin(elapsedTime * 8 + idx * 2) * 0.4, -1.2)
        clone.traverse((n) => {
          if ((n as THREE.Mesh).isMesh) {
            const mat = (n as THREE.Mesh).material as THREE.MeshBasicMaterial
            mat.opacity = 0.26 + phaseFlicker
          }
        })
      })
    } else {
      for (const c of this.illusionClones) c.visible = false
    }

    if (this.state === 'windup') {
      const pulse = 0.55 + 0.45 * Math.sin(elapsedTime * 22)
      const isHigh = this.currentAttack === 'melee-high'
      const isLow = this.currentAttack === 'melee-low'
      this.uRimColor.value.setHex(isHigh ? 0xf59e0b : isLow ? 0x38bdf8 : 0xff521b)
      this.uRimStrength.value = 1.45 + pulse * 1.85
    } else if (this.state === 'finisher-hit') {
      const pulse = 0.5 + 0.5 * Math.sin(elapsedTime * 36)
      this.uRimColor.value.setHex(0xff2e4c)
      this.uRimStrength.value = 2.1 + pulse * 1.4
    } else if (this.state === 'grapple') {
      this.uRimColor.value.setHex(0xff6b2b)
      this.uRimStrength.value = 1.15 + Math.sin(elapsedTime * 18) * 0.35
    } else if (this.state === 'absorbing') {
      this.uRimColor.value.setHex(0xc084fc)
      this.uRimStrength.value = 1.55 + Math.sin(elapsedTime * 18) * 0.45
    } else if (this.state === 'illusion') {
      this.uRimColor.value.setHex(0x38bdf8)
      this.uRimStrength.value = 1.2 + Math.sin(elapsedTime * 26) * 0.5
    } else if (this.state === 'roaring' || this.encounter.enraged) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsedTime * 8)
      this.uRimStrength.value = this.state === 'roaring' ? 2.2 : 0.42 + pulse * 0.48
    } else if (this.state === 'guarding') {
      this.uRimColor.value.setHex(0x60a5fa)
      this.uRimStrength.value = 1.5
    } else if (this.state === 'stunned' || this.state === 'staggered') {
      this.uRimColor.value.setHex(0xfacc15)
      this.uRimStrength.value = 0.72 + Math.sin(elapsedTime * 14) * 0.38
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
      const sway = Math.sin(elapsedTime * 4.5)
      this.lungeOffsetZ *= Math.exp(-6 * dt)
      this.currentZ = baseZ + this.lungeOffsetZ
      pitchX = 0.36 + sway * 0.06
      rollZ = sway * 0.15
      posY = -1.15
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
      const flank = this.stageTargetX !== null ? 0 : this.spec.id === 'baltan' ? 3.2 : 1.5
      const illusionX =
        this.state === 'illusion' ? this.encounter.illusionRealSlot * 4.6 : null
      const stalkingX =
        illusionX !== null
          ? illusionX
          : this.stageTargetX !== null
            ? this.stageTargetX
            : heroX * 0.48 + Math.cos(this.patrolPhase * 0.52) * flank
      const targetPatrolX =
        this.state === 'attack' || this.state === 'windup'
          ? this.stageTargetX !== null
            ? this.stageTargetX
            : this.encounter.targetX * 0.55
          : this.state === 'idle' || this.state === 'illusion'
            ? stalkingX
            : this.currentX
      const dx = (targetPatrolX - this.currentX) * (1 - Math.exp(-dt * 3.4))
      this.currentX += dx
      this.stepPhase += Math.abs(dx) * 1.85
      stride = Math.min(1, Math.abs(dx) / Math.max(1e-4, dt * 2.8))
      posY = Math.abs(breath) * 0.18
      yawY = Math.atan2(heroX - this.currentX, Math.max(4.5, this.heroAnchorZ - this.currentZ))

      if (this.state === 'hit') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.34) * Math.PI)
        // 按受击部位差异化反应：打头猛仰头、打胸后弓、打腿下沉
        pitchX = this.recoilHeight === 'high' ? -0.44 * p : this.recoilHeight === 'low' ? 0.24 * p : -0.28 * p
        posY += this.recoilHeight === 'low' ? -0.85 * p : 0
        this.lungeOffsetZ = -(this.recoilHeight === 'mid' ? 2.4 : 1.7) * p
        rollZ = Math.sin(this.stateTime * 42) * 0.14 * p
      } else if (this.state === 'staggered' || this.state === 'recovering') {
        const broken = this.state === 'staggered'
        const duration = broken ? 1.85 : 0.8
        const bend = Math.sin(Math.PI * Math.min(1, this.stateTime / duration)) ** 0.55
        pitchX = (broken ? 0.52 : 0.22) * bend
        rollZ = (broken ? 0.18 : -0.08) * bend
        posY -= bend * (broken ? 1.5 : 0.45)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'roaring' || this.state === 'guarding' || this.state === 'absorbing') {
        const roar = this.state === 'roaring'
        const lift = Math.sin(Math.PI * Math.min(1, this.stateTime / (roar ? 1.05 : 1.6)))
        pitchX = roar ? -0.34 * lift : this.state === 'absorbing' ? -0.14 * lift : 0.18 * lift
        posY += lift * (roar ? 0.65 : -0.35)
        this.lungeOffsetZ *= Math.exp(-7 * dt)
      } else if (this.state === 'windup') {
        const p = Math.min(1, this.stateTime / WINDUP_TIME)
        if (this.currentAttack === 'melee-low') {
          pitchX = 0.28 * p
          posY -= 1.2 * p
        } else if (this.currentAttack === 'charge') {
          pitchX = 0.34 * p
          this.lungeOffsetZ = -2.4 * p
        } else {
          pitchX = -0.24 * p
          this.lungeOffsetZ = -1.5 * p
        }
        rollZ = Math.sin(elapsedTime * 26) * 0.05 * p
      } else if (this.state === 'attack') {
        const p = Math.sin(Math.min(1, this.stateTime / 0.66) * Math.PI)
        if (this.encounter.isMeleeLike(this.currentAttack)) {
          const maxSafeZ = this.heroAnchorZ - (this.frontExtentZ + 3.2)
          const meleeReach = Math.max(1.4, Math.min(this.currentAttack === 'charge' ? 6.2 : 4.8, maxSafeZ - baseZ))
          this.lungeOffsetZ = p * meleeReach
          pitchX = this.currentAttack === 'melee-low' ? 0.36 * p : p * 0.22
          if (this.currentAttack === 'melee-low') posY -= 1.0 * p
        } else {
          this.lungeOffsetZ = p * 1.5
          pitchX = p * 0.12
        }
      } else {
        this.lungeOffsetZ += (0 - this.lungeOffsetZ) * Math.min(1, dt * 6.5)
      }
      this.currentZ = baseZ + this.lungeOffsetZ
    }

    // 叠加局部受击微抖（不破坏真实 currentX/currentZ）
    const vibAmp = this.hitVibrateTime > 0 ? this.hitVibrateIntensity * Math.min(1, this.hitVibrateTime * 6) : 0
    const vibX = vibAmp > 0 ? Math.sin(elapsedTime * 95) * vibAmp : 0
    const vibZ = vibAmp > 0 ? Math.cos(elapsedTime * 112) * vibAmp * 0.45 : 0

    this.root.position.set(this.currentX + vibX, posY, this.currentZ + vibZ)
    this.root.rotation.set(
      pitchX,
      yawY + this.recoilSide * this.hitFlash * (this.recoilHeight === 'high' ? 0.36 : 0.24),
      rollZ + this.recoilSide * this.hitFlash * 0.16,
    )

    if (this.rig) {
      const breath = Math.sin(elapsedTime * 2.4)
      if (this.rig.chest) {
        this.rig.chest.rotation.x += breath * 0.045 + (this.recoilHeight === 'mid' ? -this.hitFlash * 0.26 : 0)
      }
      if (this.rig.head) {
        const headHitSnap = this.recoilHeight === 'high' ? this.hitFlash * 0.55 : this.hitFlash * 0.2
        this.rig.head.rotation.y += Math.sin(elapsedTime * 1.4) * 0.09 + this.recoilSide * headHitSnap
        this.rig.head.rotation.x -= headHitSnap * 0.65
      }

      const step = Math.sin(this.stepPhase) * stride
      const crouch =
        this.state === 'staggered' || this.state === 'stunned'
          ? 0.48
          : this.state === 'guarding' || this.state === 'grapple' || this.currentAttack === 'melee-low'
            ? 0.32
            : 0.12
      if (this.rig.thighL) this.rig.thighL.rotation.x += crouch + step * 0.28
      if (this.rig.thighR) this.rig.thighR.rotation.x += crouch - step * 0.28
      if (this.rig.shinL) this.rig.shinL.rotation.x -= crouch + Math.max(0, step) * 0.42
      if (this.rig.shinR) this.rig.shinR.rotation.x -= crouch + Math.max(0, -step) * 0.42

      const open =
        this.state === 'roaring'
          ? Math.sin((Math.PI * this.stateTime) / 1.05)
          : this.state === 'grapple' || this.state === 'finisher-hit' || this.state === 'absorbing'
            ? 0.72 + 0.25 * Math.sin(elapsedTime * 18)
            : 0
      if (this.rig.jaw) this.rig.jaw.rotation.x += open * 0.55
      const pincers = this.state === 'windup' ? this.stateTime / WINDUP_TIME : open
      if (this.rig.clawL) this.rig.clawL.rotation.z += pincers * 0.55
      if (this.rig.clawR) this.rig.clawR.rotation.z -= pincers * 0.55

      this.poseArm(this.rig.armL, this.rig.foreL, this.rig.handL, 1, breath)
      this.poseArm(this.rig.armR, this.rig.foreR, this.rig.handR, -1, breath)

      // 机械哥莫拉/海帕杰顿长尾自然摆动
      this.rig.tail.forEach((b, idx) => {
        b.rotation.y += Math.sin(elapsedTime * 2.4 - idx * 0.42) * (0.045 + idx * 0.01)
      })
      // 加恩Q 触手 & 加坦杰厄触手波动
      const tentacleAmp = this.state === 'attack' || this.state === 'windup' ? 0.22 : 0.1
      this.rig.tentacles.forEach((b, idx) => {
        b.rotation.z += Math.sin(elapsedTime * 3.4 + idx * 0.55) * tentacleAmp
        b.rotation.x += Math.cos(elapsedTime * 2.8 + idx * 0.4) * tentacleAmp * 0.85
      })
      // 海帕杰顿光翼振翅律动
      const wingFlap = this.state === 'windup' || this.state === 'roaring' ? 0.16 : 0.06
      this.rig.wingsL.forEach((b, idx) => {
        b.rotation.y += Math.sin(elapsedTime * 4.2 - idx * 0.3) * wingFlap
      })
      this.rig.wingsR.forEach((b, idx) => {
        b.rotation.y -= Math.sin(elapsedTime * 4.2 - idx * 0.3) * wingFlap
      })

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
    const upper = this.upperDirection.set(side * 0.58, -0.72, 0.34)
    const lower = this.foreDirection.set(-side * 0.22, 0.35 + breath * 0.1, 0.96)
    if (this.state === 'grapple') {
      upper.set(side * 0.24, -0.16, 0.96)
      lower.set(side * 0.08, -0.18, 0.98)
    } else if (this.state === 'thrown' || this.state === 'finisher-hit') {
      upper.set(side * 0.85, 0.48, 0.22)
      lower.set(side * 0.72, 0.62, 0.32)
    } else if (this.state === 'guarding' || this.state === 'absorbing') {
      upper.set(side * 0.36, -0.35, 0.86)
      lower.set(-side * 0.55, 0.78, 0.22)
    } else if (this.state === 'windup') {
      const p = Math.min(1, this.stateTime / WINDUP_TIME)
      if (this.currentAttack === 'melee-high') {
        upper.set(side * 0.78, 0.62 * p, -0.35 * p)
        lower.set(side * 0.45, 0.85 * p, 0.25)
      } else if (this.currentAttack === 'melee-low') {
        upper.set(side * 0.65, -0.85, -0.35 * p)
        lower.set(side * 0.4, -0.72, 0.6)
      } else if (this.currentAttack !== 'melee' || side > 0) {
        upper.y += p * 0.8
        upper.z -= p * 0.75
        lower.y += p * 0.65
      }
    } else if (this.state === 'attack') {
      const p = Math.sin(Math.min(1, this.stateTime / 0.66) * Math.PI)
      if (this.currentAttack === 'melee-high') {
        // 高位横扫挥臂（从外向内扫过头顶高度）
        upper.set(side * (0.7 - p * 1.25), 0.45, 0.35 + p * 0.85)
        lower.set(-side * p * 0.9, 0.38, 0.88)
      } else if (this.currentAttack === 'melee-low') {
        // 低位贴地猛扫
        upper.set(side * (0.6 - p * 0.85), -0.68, 0.4 + p * 0.9)
        lower.set(-side * 0.35, -0.58, 0.95)
      } else if (this.currentAttack !== 'melee' || side > 0) {
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
    const parent = bone.parent
    if (!parent) return
    bone.getWorldPosition(this.shoulderPoint)
    tip.getWorldPosition(this.restDirection).sub(this.shoulderPoint)
    if (this.restDirection.lengthSq() < 1e-8) return
    this.parentInverse.copy(parent.matrixWorld).invert()
    this.restDirection.transformDirection(this.parentInverse)
    direction.transformDirection(this.root.matrixWorld).transformDirection(this.parentInverse)
    bone.quaternion.premultiply(this.alignment.setFromUnitVectors(this.restDirection, direction))
  }
}
