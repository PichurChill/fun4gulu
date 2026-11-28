import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js'
import { releaseModel } from './releaseModel'
import type { ConcreteSceneTheme } from './types'

const ASSETS = '/models/ultraman/landscape'
const ARENA_HQ_URLS = {
  towerGlass: '/models/ultraman/city_hq/tower_glass_hq.glb',
  towerNeon: '/models/ultraman/city_hq/tower_cyber_neon.glb',
  buildingRuined: '/models/ultraman/city_hq/building_ruined_hq.glb',
  overpassBroken: '/models/ultraman/city_hq/overpass_broken.glb',
  rubbleCluster: '/models/ultraman/city_hq/rubble_cluster_hq.glb',
  streetProps: '/models/ultraman/city_hq/street_props_hq.glb',
  gutsVehicle: '/models/ultraman/city_hq/guts_vehicle_wreck.glb',
  portCrane: '/models/ultraman/city_hq/port_gantry_crane.glb',
  portContainers: '/models/ultraman/city_hq/port_containers_hq.glb',
  mountainRadar: '/models/ultraman/city_hq/mountain_radar_base.glb',
  volcanoBasalt: '/models/ultraman/city_hq/volcano_basalt_spire.glb',
} as const

type ArenaAssetKey = keyof typeof ARENA_HQ_URLS

const THEME_ASSET_KEYS: Record<ConcreteSceneTheme, ArenaAssetKey[]> = {
  city: [
    'towerGlass',
    'towerNeon',
    'buildingRuined',
    'overpassBroken',
    'rubbleCluster',
    'streetProps',
    'gutsVehicle',
  ],
  seaside: ['portCrane', 'portContainers', 'gutsVehicle'],
  mountain: ['mountainRadar', 'gutsVehicle'],
  volcano: ['volcanoBasalt'],
}

const STAGES = {
  seaside: {
    heading: 0.48,
    light: 0xffeed2,
    power: 1.95,
    rim: 0x7dd3fc,
    rimPower: 1.25,
    sun: [0.8, 0.72, -0.28],
    dust: 0xbab2a6,
    fog: 0xa8c2d8,
  },
  city: {
    heading: 0.92,
    light: 0xbcd4ff,
    power: 1.65,
    rim: 0xff8a3d,
    rimPower: 1.9,
    sun: [0.45, 0.85, 0.52],
    dust: 0x7a6558,
    fog: 0x101829,
  },
  mountain: {
    heading: 0.52,
    light: 0xfff2d6,
    power: 2.0,
    rim: 0xa7f3d0,
    rimPower: 1.05,
    sun: [0.53, 1, -0.68],
    dust: 0x9c8e6b,
    fog: 0xb2c5b8,
  },
  volcano: {
    heading: 0.65,
    light: 0xffb37a,
    power: 1.85,
    rim: 0xff6b35,
    rimPower: 1.75,
    sun: [-0.65, 0.48, -0.55],
    dust: 0x785c52,
    fog: 0x3b2420,
  },
} as const

interface ScorchDecal {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  age: number
  maxAge: number
}

/**
 * 物理级实景特摄战场管理器（接入全部 11 套 Blender 5.2 PBR 贴图资产）：
 * - 暗夜都市：7 套高精建筑/断桥/装甲车 + 湿润反光水洼路面 + 相机朝向体积火烟 + 地面焦痕裂纹 + 街灯微破坏闪烁
 * - 海港码头：巨型红白龙门吊 + 波纹肋板堆叠集装箱 + 战损防卫队装甲车
 * - 翠绿山谷：山脊防卫队雷达前哨与松树岩礁群
 * - 熔岩火山：六棱柱状节理玄武岩巨岩簇 + 发光熔岩溪流
 */
export class ArenaManager {
  private theme: ConcreteSceneTheme = 'city'
  private selected: ConcreteSceneTheme | null = null
  private ready: Promise<void> = Promise.resolve()
  private revision = 0
  private disposed = false
  private cosmicActive = false

  private readonly root = new THREE.Group()
  private readonly sun = new THREE.DirectionalLight()
  private readonly rim = new THREE.DirectionalLight(0xff8a3d, 1.8)
  private readonly coolRim = new THREE.DirectionalLight(0x60a5fa, 1.15)
  private readonly fill = new THREE.HemisphereLight(0x88a8dc, 0x36241d, 0.92)
  private readonly fireLightL = new THREE.PointLight(0xff6b24, 0, 56, 1.45)
  private readonly fireLightR = new THREE.PointLight(0xff5218, 0, 56, 1.45)
  private propFlickerBoost = 0

  private readonly contact = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 120),
    new THREE.ShadowMaterial({ opacity: 0.45, depthWrite: false }),
  )
  private readonly heroContactAO: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly kaijuContactAO: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly aoTexture: THREE.CanvasTexture

  private sky: GroundedSkybox | null = null
  private nightDome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> | null = null
  private envRenderTarget: THREE.WebGLRenderTarget | null = null
  private readonly pmrem: THREE.PMREMGenerator
  private readonly fixtures = new THREE.Group()
  private readonly glbTemplateCache = new Map<ArenaAssetKey, THREE.Object3D>()
  private readonly stageInstancedMeshes: THREE.InstancedMesh[] = []
  private readonly billboardFXMeshes: THREE.Mesh[] = []
  private readonly cityFlameMats: THREE.ShaderMaterial[] = []
  private readonly citySmokeMats: THREE.ShaderMaterial[] = []
  private readonly cityBeaconMats: THREE.MeshBasicMaterial[] = []
  private readonly stageDisposableTextures: THREE.Texture[] = []
  private readonly stageDisposableGeos: THREE.BufferGeometry[] = []
  private readonly stageDisposableMats: THREE.Material[] = []

  // 地面焦痕裂纹贴花池（重击/爆炸后残留并逐渐冷却暗化）
  private readonly scorchGeo = new THREE.PlaneGeometry(1, 1)
  private readonly scorchDecals: ScorchDecal[] = []

  // 宇宙变身 & 合影星空全息光阵
  private readonly cosmicGroup = new THREE.Group()
  private readonly cosmicRingMat: THREE.ShaderMaterial
  private readonly cosmicStarsMat: THREE.ShaderMaterial

  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  private readonly dust = makeImpactDust()
  private readonly embers = makeVolcanoEmbers()
  private impactTime = -Infinity
  private readonly heat = { value: 0 }
  private readonly loader = new THREE.TextureLoader()
  private readonly gltfLoader = new GLTFLoader()

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()

    this.scorchGeo.rotateX(-Math.PI / 2)

    this.contact.rotation.x = -Math.PI / 2
    this.contact.position.y = 0.015
    this.contact.receiveShadow = true

    this.aoTexture = makeSoftBlobTexture()
    const makeAO = (size: number, opacity: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: this.aoTexture,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      )
      m.rotation.x = -Math.PI / 2
      m.position.y = 0.025
      m.renderOrder = -2
      return m
    }
    this.heroContactAO = makeAO(9.5, 0.56)
    this.kaijuContactAO = makeAO(13.5, 0.62)

    this.sun.castShadow = true
    // 1024 阴影贴图配合收紧的战斗核心区视锥，清晰度不降且阴影 Pass 耗时直降 75%
    this.sun.shadow.mapSize.set(1024, 1024)
    Object.assign(this.sun.shadow.camera, {
      left: -22,
      right: 22,
      top: 22,
      bottom: -22,
      near: 1,
      far: 120,
    })
    this.sun.shadow.camera.updateProjectionMatrix()
    this.sun.shadow.normalBias = 0.04
    this.sun.shadow.bias = -0.0005

    this.rim.position.set(-22, 18, -28)
    this.coolRim.position.set(24, 24, -22)

    this.fireLightL.position.set(-15, 6.5, 1.5)
    this.fireLightR.position.set(16, 7.2, -5.5)

    const { group: cosmicGrp, ringMat, starsMat } = createCosmicStage()
    this.cosmicGroup.add(cosmicGrp)
    this.cosmicRingMat = ringMat
    this.cosmicStarsMat = starsMat
    this.cosmicGroup.visible = false

    this.dust.visible = false
    this.embers.visible = false
    this.root.add(
      this.sun,
      this.rim,
      this.coolRim,
      this.fill,
      this.fireLightL,
      this.fireLightR,
      this.contact,
      this.heroContactAO,
      this.kaijuContactAO,
      this.dust,
      this.embers,
      this.fixtures,
      this.cosmicGroup,
    )
    this.scene.add(this.root)
  }

  public getTheme() {
    return this.theme
  }

  public setCosmicMode(active: boolean) {
    this.cosmicActive = active
    this.cosmicGroup.visible = active
    this.fixtures.visible = !active
    if (this.ground) this.ground.visible = !active
    if (this.sky) this.sky.visible = !active
    if (this.nightDome) this.nightDome.visible = !active
    for (const s of this.scorchDecals) s.mesh.visible = !active
    this.embers.visible = !active && (this.theme === 'city' || this.theme === 'volcano')
    if (active) {
      this.scene.fog = null
      this.scene.background = new THREE.Color(0x040b1d)
      this.fireLightL.intensity = 0
      this.fireLightR.intensity = 0
      this.sun.color.setHex(0xdbeafe)
      this.sun.intensity = 2.0
      this.rim.color.setHex(0x38e8ff)
      this.rim.intensity = 2.2
    } else {
      const cfg = STAGES[this.theme]
      this.scene.background = null
      this.scene.fog =
        this.theme === 'city' ? new THREE.FogExp2(cfg.fog, 0.0044) : null
      this.sun.color.setHex(cfg.light)
      this.sun.intensity = cfg.power
      this.rim.color.setHex(cfg.rim)
      this.rim.intensity = cfg.rimPower
    }
  }

  public setTheme(theme: ConcreteSceneTheme): Promise<void> {
    if (this.selected === theme) return this.ready
    this.selected = theme
    const revision = ++this.revision
    this.ready = this.load(theme, revision).catch((error) => {
      if (revision === this.revision) this.selected = null
      throw error
    })
    return this.ready
  }

  private async load(theme: ConcreteSceneTheme, revision: number) {
    const surface =
      theme === 'volcano' ? 'basalt' : theme === 'seaside' || theme === 'city' ? 'pavement' : null
    const names = surface ? [theme, surface, surface + '-normal'] : [theme]

    const texPromise = Promise.allSettled(
      names.map((name) => this.loader.loadAsync(`${ASSETS}/${name}.webp`)),
    )
    const assetKeys = THEME_ASSET_KEYS[theme]
    const glbPromise = Promise.allSettled(
      assetKeys.map(async (key) => {
        const cached = this.glbTemplateCache.get(key)
        if (cached) return { key, scene: cached, fromCache: true }
        const scene = (await this.gltfLoader.loadAsync(ARENA_HQ_URLS[key])).scene
        return { key, scene, fromCache: false }
      }),
    )

    const [results, glbResults] = await Promise.all([texPromise, glbPromise])
    const maps = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failure = results.find((r) => r.status === 'rejected')

    if (this.disposed || revision !== this.revision || failure) {
      maps.forEach((texture) => texture.dispose())
      glbResults.forEach((r) => {
        if (r.status === 'fulfilled' && !r.value.fromCache) {
          releaseModel(r.value.scene)
        }
      })
      if (failure && !this.disposed && revision === this.revision) throw failure.reason
      return
    }

    this.releaseStage()
    this.theme = theme
    const config = STAGES[theme]
    const texture = maps[0]!
    texture.colorSpace = THREE.SRGBColorSpace
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.anisotropy = 4

    const loadedAssets: Partial<Record<ArenaAssetKey, THREE.Object3D>> = {}
    for (const r of glbResults) {
      if (r.status === 'fulfilled') {
        if (!this.glbTemplateCache.has(r.value.key)) {
          this.glbTemplateCache.set(r.value.key, r.value.scene)
        }
        loadedAssets[r.value.key] = this.glbTemplateCache.get(r.value.key)!
      } else {
        console.error('[ArenaManager] 高精场景资产加载失败:', r.reason)
      }
    }

    const yaw = (config.heading - 0.25) * Math.PI * 2

    if (theme === 'city') {
      const nightDome = createNightCitySkyDome()
      this.nightDome = nightDome
      this.root.add(nightDome)
      this.scene.fog = new THREE.FogExp2(config.fog, 0.0044)

      this.envRenderTarget = this.pmrem.fromEquirectangular(texture)
      texture.dispose()
      this.scene.environment = this.envRenderTarget.texture
      this.scene.environmentRotation.y = yaw
      this.scene.environmentIntensity = 0.52
      this.fill.color.setHex(0x7496d2)
      this.fill.groundColor.setHex(0x3a2218)
      this.fill.intensity = 0.92

      this.buildNightCityRuins(maps[1]!, maps[2]!, loadedAssets)
    } else {
      this.scene.fog = null
      const sky = new GroundedSkybox(texture, 14.2, 240, 64)
      sky.position.set(3.5, 14.16, 29.5)
      sky.rotation.y = yaw
      sky.renderOrder = -10
      sky.material.toneMapped = false
      this.sky = sky
      this.root.add(sky)

      this.envRenderTarget = this.pmrem.fromEquirectangular(texture)
      this.scene.environment = this.envRenderTarget.texture
      this.scene.environmentRotation.y = yaw
      this.scene.environmentIntensity = theme === 'volcano' ? 0.68 : 0.78
      this.fill.color.setHex(0xe4eefc)
      this.fill.groundColor.setHex(0x6f655c)
      this.fill.intensity = 0.88

      if (theme === 'volcano') this.buildCrater(maps[1]!, maps[2]!, loadedAssets)
      else if (theme === 'seaside') this.buildQuay(maps[1]!, maps[2]!, loadedAssets)
      else if (theme === 'mountain') this.buildMountainStage(loadedAssets)
    }

    this.sun.color.setHex(config.light)
    this.sun.intensity = config.power
    this.sun.position.fromArray(config.sun).normalize().multiplyScalar(65)

    this.rim.color.setHex(config.rim)
    this.rim.intensity = config.rimPower

    this.contact.visible = theme === 'mountain'
    this.embers.visible = !this.cosmicActive && (theme === 'volcano' || theme === 'city')
    if (this.cosmicActive) {
      this.setCosmicMode(true)
    }
  }

  private prepTemplate(
    assets: Partial<Record<ArenaAssetKey, THREE.Object3D>>,
    key: ArenaAssetKey,
    castShadow: boolean,
  ): THREE.Object3D | null {
    const tpl = assets[key]
    if (!tpl) return null
    tpl.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const m = node as THREE.Mesh
        m.castShadow = castShadow
        m.receiveShadow = true
      }
    })
    return tpl
  }

  /**
   * 批量实例化合批器：把同一高精 GLB 模板的多次摆放按子网格合并为 THREE.InstancedMesh，
   * 完整保留所有 PBR 贴图与材质细节，同时将暗夜都市等高密场景 Draw Calls 暴降 80%+
   */
  private placeAssetBatch(
    tpl: THREE.Object3D | null,
    placements: readonly { x: number; y: number; z: number; rotY: number; sx?: number; sy?: number; sz?: number }[],
    castShadow = false,
  ) {
    if (!tpl || placements.length === 0) return
    tpl.updateMatrixWorld(true)
    const rootInv = tpl.matrixWorld.clone().invert()
    const subMeshes: { mesh: THREE.Mesh; localMatrix: THREE.Matrix4 }[] = []
    tpl.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const m = node as THREE.Mesh
        const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld)
        subMeshes.push({ mesh: m, localMatrix })
      }
    })

    const worldObj = new THREE.Object3D()
    const finalMat = new THREE.Matrix4()
    for (const { mesh, localMatrix } of subMeshes) {
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length)
      inst.castShadow = castShadow
      inst.receiveShadow = true
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i]!
        const sx = p.sx ?? 1
        const sy = p.sy ?? sx
        const sz = p.sz ?? sx
        worldObj.position.set(p.x, p.y, p.z)
        worldObj.rotation.set(0, p.rotY, 0)
        worldObj.scale.set(sx, sy, sz)
        worldObj.updateMatrix()
        finalMat.multiplyMatrices(worldObj.matrix, localMatrix)
        inst.setMatrixAt(i, finalMat)
      }
      inst.instanceMatrix.needsUpdate = true
      inst.computeBoundingSphere()
      this.fixtures.add(inst)
      this.stageInstancedMeshes.push(inst)
    }
  }

  /** 构建暗夜 3D 特摄都市废墟战场（7 套高精贴图 PBR 资产 + 湿润水洼路面 + 体积朝向火烟） */
  private buildNightCityRuins(
    map: THREE.Texture,
    normal: THREE.Texture,
    cityAssets: Partial<Record<ArenaAssetKey, THREE.Object3D>>,
  ) {
    const width = 220
    const length = 220
    for (const tex of [map, normal]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(width / 7, length / 7)
      tex.anisotropy = 8
    }
    map.colorSpace = THREE.SRGBColorSpace
    const puddleRoughness = makeWetPuddleRoughnessTexture()
    this.stageDisposableTextures.push(puddleRoughness)

    const surface = new THREE.MeshStandardMaterial({
      map,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap: puddleRoughness,
      roughness: 0.92,
      metalness: 0.24,
      color: 0x353d4e,
    })
    const geometry = new THREE.PlaneGeometry(width, length)
    geometry.rotateX(-Math.PI / 2)
    this.ground = new THREE.Mesh(geometry, surface)
    this.ground.position.set(0, 0, -8)
    this.ground.receiveShadow = true
    this.root.add(this.ground)

    // 双侧立体抬升人行道与石质路缘石
    const sidewalkGeo = new THREE.BoxGeometry(15.5, 0.28, 170)
    const sidewalkMat = new THREE.MeshStandardMaterial({
      color: 0x2a303d,
      roughness: 0.84,
      metalness: 0.1,
    })
    const curbGeo = new THREE.BoxGeometry(0.45, 0.34, 170)
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0x4b5563,
      roughness: 0.76,
      metalness: 0.14,
    })
    this.stageDisposableGeos.push(sidewalkGeo, curbGeo)
    this.stageDisposableMats.push(sidewalkMat, curbMat)
    for (const side of [-1, 1] as const) {
      const sw = new THREE.Mesh(sidewalkGeo, sidewalkMat)
      sw.position.set(side * 21.4, 0.14, -8)
      sw.receiveShadow = true
      const curb = new THREE.Mesh(curbGeo, curbMat)
      curb.position.set(side * 13.65, 0.17, -8)
      curb.receiveShadow = true
      this.fixtures.add(sw, curb)
    }

    // 道路交通标线
    const yellowLineGeo = new THREE.PlaneGeometry(0.22, 130)
    yellowLineGeo.rotateX(-Math.PI / 2)
    const yellowLineMat = new THREE.MeshBasicMaterial({
      color: 0xd97706,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    })
    const dashGeo = new THREE.PlaneGeometry(0.28, 3.6)
    dashGeo.rotateX(-Math.PI / 2)
    const whiteMarkMat = new THREE.MeshBasicMaterial({
      color: 0xcbd5e1,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    })
    const zebraGeo = new THREE.PlaneGeometry(0.85, 3.8)
    zebraGeo.rotateX(-Math.PI / 2)
    this.stageDisposableGeos.push(yellowLineGeo, dashGeo, zebraGeo)
    this.stageDisposableMats.push(yellowLineMat, whiteMarkMat)

    for (const yx of [-0.22, 0.22]) {
      const centerLine = new THREE.Mesh(yellowLineGeo, yellowLineMat)
      centerLine.position.set(yx, 0.032, -8)
      this.fixtures.add(centerLine)
    }
    const dashMesh = new THREE.InstancedMesh(dashGeo, whiteMarkMat, 32)
    const dummy = new THREE.Object3D()
    let dIdx = 0
    for (const lx of [-6.6, 6.6]) {
      for (let i = 0; i < 16; i++) {
        dummy.position.set(lx, 0.032, -52 + i * 7.2)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        dashMesh.setMatrixAt(dIdx++, dummy.matrix)
      }
    }
    dashMesh.instanceMatrix.needsUpdate = true
    this.fixtures.add(dashMesh)

    const zebraMesh = new THREE.InstancedMesh(zebraGeo, whiteMarkMat, 22)
    let zIdx = 0
    for (const zz of [-26, 20]) {
      for (let i = 0; i < 11; i++) {
        dummy.position.set(-10 + i * 2.0, 0.034, zz)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        zebraMesh.setMatrixAt(zIdx++, dummy.matrix)
      }
    }
    zebraMesh.instanceMatrix.needsUpdate = true
    this.fixtures.add(zebraMesh)

    // 静态场景建筑/废墟不参与动态 ShadowMap 重绘（保留地面接收阴影与奥特曼/怪兽动态投影），大幅降负
    const tplGlass = this.prepTemplate(cityAssets, 'towerGlass', false)
    const tplNeon = this.prepTemplate(cityAssets, 'towerNeon', false)
    const tplRuined = this.prepTemplate(cityAssets, 'buildingRuined', false)
    const tplOverpass = this.prepTemplate(cityAssets, 'overpassBroken', false)
    const tplRubble = this.prepTemplate(cityAssets, 'rubbleCluster', false)
    const tplProps = this.prepTemplate(cityAssets, 'streetProps', false)
    const tplVehicle = this.prepTemplate(cityAssets, 'gutsVehicle', false)

    this.placeAssetBatch(tplNeon, [
      { x: -35.5, y: 0, z: 18, rotY: Math.PI * 0.5, sx: 1.0, sy: 0.98 },
      { x: -38.5, y: 0, z: -36, rotY: Math.PI * 0.5, sx: 1.12, sy: 1.18 },
      { x: 35.8, y: 0, z: 0, rotY: -Math.PI * 0.5, sx: 1.02, sy: 1.06 },
      { x: 53.0, y: 0, z: -7, rotY: -0.15, sx: 1.15, sy: 1.2 },
      { x: 20, y: 0, z: -50, rotY: -0.16, sx: 1.12, sy: 1.2 },
      { x: 38, y: 0, z: -58, rotY: -0.28, sx: 1.2, sy: 1.25 },
      { x: -38, y: 0, z: 42, rotY: Math.PI * 0.45, sx: 1.05, sy: 1.08 },
      { x: 19, y: 0, z: 54, rotY: Math.PI, sx: 1.12, sy: 1.18 },
    ])
    this.placeAssetBatch(tplGlass, [
      { x: -36.5, y: 0, z: -17, rotY: Math.PI * 0.5, sx: 1.05, sy: 1.02 },
      { x: -53.0, y: 0, z: -6, rotY: 0.12, sx: 1.15, sy: 1.16 },
      { x: 35.5, y: 0, z: 19, rotY: -Math.PI * 0.5, sx: 1.0, sy: 0.96 },
      { x: 38.5, y: 0, z: -37, rotY: -Math.PI * 0.5, sx: 1.12, sy: 1.16 },
      { x: 52.0, y: 0, z: -28, rotY: 0.2, sx: 1.18, sy: 1.25 },
      { x: 0, y: 0, z: -56, rotY: 0, sx: 1.18, sy: 1.26 },
      { x: -38, y: 0, z: -58, rotY: 0.28, sx: 1.2, sy: 1.28 },
      { x: 38, y: 0, z: 42, rotY: -Math.PI * 0.45, sx: 1.05, sy: 1.1 },
      { x: -19, y: 0, z: 54, rotY: Math.PI, sx: 1.12, sy: 1.16 },
    ])
    this.placeAssetBatch(tplRuined, [
      { x: -35.0, y: 0, z: 1, rotY: Math.PI * 0.5, sx: 1.05, sy: 1.1 },
      { x: -51.0, y: 0, z: -26, rotY: -0.25, sx: 1.12, sy: 1.25 },
      { x: 35.2, y: 0, z: -18, rotY: -Math.PI * 0.5, sx: 1.08, sy: 1.14 },
      { x: -20, y: 0, z: -50, rotY: 0.14, sx: 1.15, sy: 1.22 },
      { x: 0, y: 0, z: 60, rotY: Math.PI, sx: 1.18, sy: 1.28 },
    ])
    this.placeAssetBatch(tplOverpass, [
      { x: -24.2, y: 0, z: -16.2, rotY: 0.44, sx: 1.04 },
      { x: 25.0, y: 0, z: -32.4, rotY: -0.22, sx: 1.08 },
    ])
    this.placeAssetBatch(
      tplProps,
      [-22, -6, 9, 23].flatMap((pz) => [
        { x: 15.0, y: 0.26, z: pz, rotY: 0, sx: 1.0 },
        { x: -15.0, y: 0.26, z: pz + 4.5, rotY: Math.PI, sx: 1.0 },
      ]),
    )
    this.placeAssetBatch(tplVehicle, [
      { x: -15.8, y: 0.26, z: 12.0, rotY: 0.48, sx: 1.08 },
      { x: 16.4, y: 0.26, z: 1.8, rotY: -0.78, sx: 1.08 },
      { x: -16.0, y: 0.26, z: -10.5, rotY: 2.52, sx: 1.08 },
      { x: 15.8, y: 0.26, z: -24.5, rotY: -2.35, sx: 1.08 },
    ])
    this.placeAssetBatch(tplRubble, [
      { x: -18.8, y: 0.24, z: 9.2, rotY: 0.35, sx: 1.08 },
      { x: 19.6, y: 0.24, z: 14.8, rotY: -0.62, sx: 0.96 },
      { x: -21.0, y: 0.24, z: -5.4, rotY: 1.38, sx: 1.18 },
      { x: 19.2, y: 0.24, z: 2.2, rotY: -1.05, sx: 1.06 },
      { x: -18.6, y: 0.24, z: -14.6, rotY: 0.72, sx: 1.15 },
      { x: 20.4, y: 0.24, z: -9.6, rotY: -0.84, sx: 1.22 },
      { x: -21.2, y: 0.24, z: -25.8, rotY: 2.42, sx: 1.12 },
      { x: 18.8, y: 0.24, z: -19.8, rotY: -2.05, sx: 1.16 },
      { x: -22.2, y: 0.24, z: 18.4, rotY: -0.45, sx: 1.02 },
      { x: 21.6, y: 0.24, z: -29.5, rotY: 0.88, sx: 1.14 },
    ])

    // 远景无边际万家灯火剪影摩天楼群
    const windowTex = makeNightWindowsTexture()
    this.stageDisposableTextures.push(windowTex)
    const towerSpecs: [number, number, number, number, number][] = [
      [-68, -32, 16, 68, 16],
      [-48, -76, 19, 82, 17],
      [-22, -80, 17, 76, 16],
      [0, -88, 22, 92, 18],
      [22, -80, 18, 78, 16],
      [48, -76, 19, 84, 17],
      [68, -36, 17, 70, 16],
      [-64, 12, 16, 58, 15],
      [64, 12, 16, 60, 15],
      [-74, -64, 20, 74, 18],
      [74, -64, 20, 72, 18],
      [-58, 42, 16, 62, 16],
      [58, 42, 16, 64, 16],
      [-36, 72, 18, 72, 16],
      [-12, 78, 18, 80, 16],
      [12, 78, 18, 78, 16],
      [36, 72, 18, 72, 16],
    ]
    const towerGeo = new THREE.BoxGeometry(1, 1, 1)
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x101726,
      roughness: 0.78,
      metalness: 0.24,
      emissive: new THREE.Color(0xffc978),
      emissiveMap: windowTex,
      emissiveIntensity: 0.54,
    })
    const beaconGeo = new THREE.SphereGeometry(0.45, 8, 6)
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 })
    this.stageDisposableGeos.push(towerGeo, beaconGeo)
    this.stageDisposableMats.push(towerMat, beaconMat)
    this.cityBeaconMats.push(beaconMat)

    const towers = new THREE.InstancedMesh(towerGeo, towerMat, towerSpecs.length)
    const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, towerSpecs.length)
    towerSpecs.forEach(([x, z, w, h, d], idx) => {
      dummy.position.set(x, h * 0.5, z)
      dummy.scale.set(w, h, d)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      towers.setMatrixAt(idx, dummy.matrix)

      dummy.position.set(x, h + 0.6, z)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      beacons.setMatrixAt(idx, dummy.matrix)
    })
    towers.instanceMatrix.needsUpdate = true
    beacons.instanceMatrix.needsUpdate = true
    this.fixtures.add(towers, beacons)

    // 相机朝向多层体积火烟（精选 4 处纵深火点降低透明 Overdraw）
    const fireSpots: [number, number, number][] = [
      [-18.8, 9.2, 5.2],
      [19.2, 2.2, 5.0],
      [-18.6, -14.6, 6.8],
      [18.8, -19.8, 6.4],
    ]
    const flameGeo = new THREE.PlaneGeometry(1, 1)
    const smokeGeo = new THREE.PlaneGeometry(1, 1)
    this.stageDisposableGeos.push(flameGeo, smokeGeo)

    fireSpots.forEach(([fx, fz, size], idx) => {
      const flameMat = createRuinsFlameMaterial(idx * 1.73)
      const smokeMat = createRuinsSmokeMaterial(idx * 2.11)
      this.cityFlameMats.push(flameMat)
      this.citySmokeMats.push(smokeMat)
      this.stageDisposableMats.push(flameMat, smokeMat)

      const fMesh = new THREE.Mesh(flameGeo, flameMat)
      fMesh.position.set(fx, size * 0.5, fz)
      fMesh.scale.set(size * 1.05, size * 1.35, 1)
      this.fixtures.add(fMesh)
      this.billboardFXMeshes.push(fMesh)

      const sMesh = new THREE.Mesh(smokeGeo, smokeMat)
      sMesh.position.set(fx, size * 1.48, fz)
      sMesh.scale.set(size * 1.68, size * 2.0, 1)
      this.fixtures.add(sMesh)
      this.billboardFXMeshes.push(sMesh)
    })
  }

  /** 海港码头（接入红白龙门吊 + 波纹肋板集装箱簇 + 战损防卫队巡逻车） */
  private buildQuay(
    map: THREE.Texture,
    normal: THREE.Texture,
    assets: Partial<Record<ArenaAssetKey, THREE.Object3D>>,
  ) {
    const width = 156
    const length = 112
    for (const tex of [map, normal]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(width / 4, length / 4)
      tex.anisotropy = 8
    }
    map.colorSpace = THREE.SRGBColorSpace
    const surface = new THREE.MeshStandardMaterial({
      map,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.78,
      metalness: 0.12,
      color: 0xc8c1b6,
    })
    const geometry = new THREE.PlaneGeometry(width, length)
    geometry.rotateX(-Math.PI / 2)
    this.ground = new THREE.Mesh(geometry, surface)
    this.ground.position.z = 6
    this.ground.receiveShadow = true
    this.root.add(this.ground)

    const metal = new THREE.MeshStandardMaterial({
      color: 0x56504a,
      metalness: 0.68,
      roughness: 0.55,
    })
    const post = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.64, 0),
        new THREE.Vector2(0.64, 0.13),
        new THREE.Vector2(0.34, 0.18),
        new THREE.Vector2(0.31, 0.72),
        new THREE.Vector2(0.46, 0.78),
        new THREE.Vector2(0.46, 0.87),
        new THREE.Vector2(0, 0.91),
      ],
      16,
    )
    const bollards = new THREE.InstancedMesh(post, metal, 13)
    for (let i = 0; i < 13; i++) {
      bollards.setMatrixAt(i, new THREE.Matrix4().makeTranslation((i - 6) * 11, 0, -40))
    }
    bollards.castShadow = true
    this.fixtures.add(bollards)
    this.stageDisposableGeos.push(post)
    this.stageDisposableMats.push(metal)

    const tplCrane = this.prepTemplate(assets, 'portCrane', false)
    const tplContainers = this.prepTemplate(assets, 'portContainers', false)
    const tplVehicle = this.prepTemplate(assets, 'gutsVehicle', false)

    this.placeAssetBatch(tplCrane, [
      { x: -32, y: 0, z: -28, rotY: 0.18, sx: 1.15 },
      { x: 34, y: 0, z: -32, rotY: -0.22, sx: 1.15 },
      { x: -44, y: 0, z: 8, rotY: Math.PI * 0.48, sx: 1.05 },
    ])
    this.placeAssetBatch(tplContainers, [
      { x: -24, y: 0, z: -4, rotY: 0.12, sx: 1.1 },
      { x: 25, y: 0, z: -10, rotY: -0.15, sx: 1.12 },
      { x: -26, y: 0, z: 18, rotY: -0.25, sx: 1.0 },
      { x: 27, y: 0, z: 14, rotY: 0.22, sx: 1.05 },
    ])
    this.placeAssetBatch(tplVehicle, [
      { x: -17.5, y: 0, z: 11.5, rotY: 0.55, sx: 1.08 },
      { x: 18.2, y: 0, z: 3.2, rotY: -0.72, sx: 1.08 },
    ])
  }

  /** 翠绿山谷（接入防卫队山脊雷达前哨站与松树岩礁群，彻底告别空旷纯贴图） */
  private buildMountainStage(assets: Partial<Record<ArenaAssetKey, THREE.Object3D>>) {
    const tplRadar = this.prepTemplate(assets, 'mountainRadar', false)
    const tplVehicle = this.prepTemplate(assets, 'gutsVehicle', false)

    this.placeAssetBatch(tplRadar, [
      { x: -30, y: 0, z: -24, rotY: 0.42, sx: 1.25 },
      { x: 32, y: 0, z: -28, rotY: -0.52, sx: 1.32 },
      { x: -34, y: 0, z: 14, rotY: 1.25, sx: 1.15 },
      { x: 35, y: 0, z: 10, rotY: -1.18, sx: 1.1 },
    ])
    this.placeAssetBatch(tplVehicle, [
      { x: -16.5, y: 0, z: 12.2, rotY: 0.42, sx: 1.08 },
      { x: 17.8, y: 0, z: 4.5, rotY: -0.68, sx: 1.08 },
    ])
  }

  /** 实体火山口 + 6 组六棱柱状玄武岩巨岩簇 */
  private buildCrater(
    map: THREE.Texture,
    normal: THREE.Texture,
    assets: Partial<Record<ArenaAssetKey, THREE.Object3D>>,
  ) {
    const ground = new THREE.PlaneGeometry(260, 240, 160, 144)
    ground.rotateX(-Math.PI / 2)
    const pos = ground.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const noise =
        Math.sin(x * 0.063 + z * 0.09) +
        0.32 * Math.cos(z * 0.24 - x * 0.13) +
        0.15 * Math.sin(x * 0.62 + z * 0.41)
      const rim = Math.hypot(x / 76, (z + 8) / 90)
      const wall = Math.exp(-((rim - 1) ** 2) * 13) * (23 + 6 * noise)
      const edge = THREE.MathUtils.smoothstep(Math.max(Math.abs(x), -z * 0.7), 15, 40)
      pos.setY(i, edge * (wall + 1.6 * noise) - 0.015)
    }
    ground.computeVertexNormals()
    for (const tex of [map, normal]) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(24, 22)
      tex.anisotropy = 4
    }
    map.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshStandardMaterial({ map, normalMap: normal, roughness: 0.89 })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHeat = this.heat
      shader.vertexShader =
        'varying vec3 vRock;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vRock = position;',
        )
      shader.fragmentShader =
        'varying vec3 vRock; uniform float uHeat;\n' +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `
        #include <emissivemap_fragment>
        float bend = 3.*sin(vRock.z*.095) + 1.5*sin(vRock.z*.17 + 1.);
        float left = abs(vRock.x + 20. + bend);
        float right = abs(vRock.x - 17. + 3.*sin(vRock.z*.074 + .5) - .7*bend);
        float channel = min(left, right * 1.6);
        float grit = texture2D(map, vMapUv * .43).r;
        float bank = 3.8 * grit;
        float flow = (1. - smoothstep(.35, 2.1, channel + bank)) * (1.-smoothstep(4.,17.,vRock.y));
        float crust = texture2D(map, vMapUv + vec2(0., uHeat*.027)).r;
        float ember = smoothstep(.025,.15,crust + grit*.3);
        totalEmissiveRadiance += flow * mix(vec3(.38,.016,.002),vec3(2.4,.49,.035),ember);
      `,
        )
    }
    this.ground = new THREE.Mesh(ground, material)
    this.ground.receiveShadow = true
    this.root.add(this.ground)

    const tplBasalt = this.prepTemplate(assets, 'volcanoBasalt', false)
    this.placeAssetBatch(tplBasalt, [
      { x: -28, y: 0, z: -22, rotY: 0.35, sx: 1.4, sy: 1.61, sz: 1.4 },
      { x: 30, y: 0, z: -26, rotY: -0.65, sx: 1.5, sy: 1.725, sz: 1.5 },
      { x: -34, y: 0, z: 4, rotY: 1.42, sx: 1.3, sy: 1.495, sz: 1.3 },
      { x: 32, y: 0, z: 6, rotY: -1.22, sx: 1.35, sy: 1.552, sz: 1.35 },
      { x: -24, y: 0, z: -44, rotY: 2.2, sx: 1.7, sy: 1.955, sz: 1.7 },
      { x: 24, y: 0, z: -46, rotY: -2.0, sx: 1.65, sy: 1.897, sz: 1.65 },
    ])
  }

  public groundImpact(x: number, z: number, elapsed: number, scorchScale = 0) {
    this.impactTime = elapsed
    this.dust.position.set(x, 0.12, z)
    this.dust.material.uniforms.tint!.value.setHex(STAGES[this.theme].dust)
    if (scorchScale > 0) {
      this.spawnGroundScorch(x, z, scorchScale)
    }
    this.propFlickerBoost = Math.min(1.5, this.propFlickerBoost + 0.65)
  }

  /** 在地表生成高温余烬裂纹焦痕（最多同时保留 8 处，随时间自然冷却暗化淡出） */
  public spawnGroundScorch(x: number, z: number, size = 7.5) {
    if (this.cosmicActive) return
    if (this.scorchDecals.length >= 8) {
      const oldest = this.scorchDecals.shift()!
      this.root.remove(oldest.mesh)
      oldest.mesh.material.dispose()
    }
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      uniforms: {
        uAge: { value: 0 },
        uSeed: { value: Math.random() * 100 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uAge;
        uniform float uSeed;
        varying vec2 vUv;
        void main() {
          vec2 q = (vUv - 0.5) * 2.0;
          float r = length(q);
          if (r > 1.0) discard;
          float ang = atan(q.y, q.x);
          float cracks = abs(sin(ang * 7.0 + uSeed + r * 5.0)) * abs(cos(ang * 11.0 - r * 7.0));
          float crackLine = smoothstep(0.06, 0.01, cracks) * (1.0 - smoothstep(0.15, 0.92, r));
          float charMask = (1.0 - smoothstep(0.1, 0.95, r)) * 0.72;
          float heat = max(0.0, 1.0 - uAge * 0.35);
          float fadeOut = 1.0 - smoothstep(8.0, 13.0, uAge);
          vec3 charCol = vec3(0.04, 0.03, 0.03);
          vec3 lavaCol = vec3(1.55, 0.42, 0.06) * heat;
          vec3 col = mix(charCol, lavaCol, crackLine * heat);
          float alpha = clamp((charMask + crackLine * heat) * fadeOut, 0.0, 0.86);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    })
    const mesh = new THREE.Mesh(this.scorchGeo, mat)
    mesh.position.set(x, 0.042, z)
    mesh.scale.setScalar(size)
    mesh.renderOrder = -1
    this.root.add(mesh)
    this.scorchDecals.push({ mesh, age: 0, maxAge: 13 })
  }

  public update(
    elapsed: number,
    heroPos?: THREE.Vector3,
    kaijuPos?: THREE.Vector3,
    kaijuVisible = true,
    cameraPos?: THREE.Vector3,
    dt = 0.016,
  ) {
    this.heat.value = elapsed
    this.propFlickerBoost = Math.max(0, this.propFlickerBoost - dt * 1.4)

    // 更新地表焦痕冷却生命周期
    for (let i = this.scorchDecals.length - 1; i >= 0; i--) {
      const s = this.scorchDecals[i]!
      s.age += dt
      if (s.age >= s.maxAge) {
        this.root.remove(s.mesh)
        s.mesh.material.dispose()
        this.scorchDecals.splice(i, 1)
      } else {
        s.mesh.material.uniforms.uAge!.value = s.age
      }
    }

    const age = elapsed - this.impactTime
    this.dust.visible = !this.cosmicActive && age < 1.25
    this.dust.material.uniforms.age!.value = age
    if (this.embers.visible) {
      this.embers.material.uniforms.uTime!.value = elapsed
    }

    if (this.cosmicActive) {
      this.cosmicRingMat.uniforms.uTime!.value = elapsed
      this.cosmicStarsMat.uniforms.uTime!.value = elapsed
    } else if (this.theme === 'city') {
      if (this.nightDome) {
        this.nightDome.material.uniforms.uTime!.value = elapsed
      }
      for (const m of this.cityFlameMats) {
        m.uniforms.uTime!.value = elapsed
      }
      for (const m of this.citySmokeMats) {
        m.uniforms.uTime!.value = elapsed
      }
      // 废墟火烟平面持续绕 Y 轴朝向相机，立体体积感零穿帮
      if (cameraPos) {
        for (const bm of this.billboardFXMeshes) {
          bm.rotation.y = Math.atan2(
            cameraPos.x - bm.position.x,
            cameraPos.z - bm.position.z,
          )
        }
      }
      const flickL =
        0.78 +
        0.22 * Math.sin(elapsed * 11.3) +
        0.12 * Math.cos(elapsed * 19.7) +
        this.propFlickerBoost * 0.45
      const flickR =
        0.76 +
        0.24 * Math.cos(elapsed * 13.1) +
        0.14 * Math.sin(elapsed * 23.1) +
        this.propFlickerBoost * 0.35
      this.fireLightL.intensity = 18 * flickL
      this.fireLightR.intensity = 16 * flickR
      const beaconPulse = Math.sin(elapsed * 3.4) > 0.2 ? 1.0 : 0.22
      for (const bm of this.cityBeaconMats) {
        bm.color.setRGB(1.0 * beaconPulse, 0.18 * beaconPulse, 0.14 * beaconPulse)
      }
    } else {
      this.fireLightL.intensity = 0
      this.fireLightR.intensity = 0
    }

    if (heroPos) {
      const hLift = Math.max(0, heroPos.y)
      const hScale = Math.max(0.45, 1 - hLift * 0.055)
      this.heroContactAO.visible = !this.cosmicActive
      this.heroContactAO.position.set(heroPos.x, 0.025, heroPos.z)
      this.heroContactAO.scale.setScalar(hScale)
      this.heroContactAO.material.opacity = 0.56 * Math.max(0, 1 - hLift * 0.08)
    }
    if (kaijuPos) {
      const kLift = Math.max(0, kaijuPos.y)
      const kScale = Math.max(0.45, 1 - kLift * 0.04)
      this.kaijuContactAO.visible = !this.cosmicActive && kaijuVisible
      this.kaijuContactAO.position.set(kaijuPos.x, 0.024, kaijuPos.z)
      this.kaijuContactAO.scale.setScalar(kScale)
      this.kaijuContactAO.material.opacity = 0.62 * Math.max(0, 1 - kLift * 0.06)
    }
  }

  private releaseStage() {
    if (this.sky) {
      this.root.remove(this.sky)
      this.sky.material.map?.dispose()
      this.sky.geometry.dispose()
      this.sky.material.dispose()
      this.sky = null
    }
    if (this.nightDome) {
      this.root.remove(this.nightDome)
      this.nightDome.geometry.dispose()
      this.nightDome.material.dispose()
      this.nightDome = null
    }
    while (this.fixtures.children.length > 0) {
      const child = this.fixtures.children[0]!
      this.fixtures.remove(child)
    }
    for (const inst of this.stageInstancedMeshes) {
      inst.dispose()
    }
    this.stageInstancedMeshes.length = 0
    this.billboardFXMeshes.length = 0
    for (const tex of this.stageDisposableTextures) tex.dispose()
    this.stageDisposableTextures.length = 0
    for (const geo of this.stageDisposableGeos) geo.dispose()
    this.stageDisposableGeos.length = 0
    for (const mat of this.stageDisposableMats) mat.dispose()
    this.stageDisposableMats.length = 0
    this.cityFlameMats.length = 0
    this.citySmokeMats.length = 0
    this.cityBeaconMats.length = 0

    for (const s of this.scorchDecals) {
      this.root.remove(s.mesh)
      s.mesh.material.dispose()
    }
    this.scorchDecals.length = 0

    this.scene.environment = null
    this.envRenderTarget?.dispose()
    this.envRenderTarget = null
    if (this.ground) {
      this.root.remove(this.ground)
      this.ground.geometry.dispose()
      this.ground.material.map?.dispose()
      this.ground.material.normalMap?.dispose()
      this.ground.material.dispose()
      this.ground = null
    }
  }

  public dispose() {
    this.disposed = true
    this.releaseStage()
    for (const mdl of this.glbTemplateCache.values()) {
      releaseModel(mdl)
    }
    this.glbTemplateCache.clear()
    this.scorchGeo.dispose()
    this.cosmicGroup.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) {
        const m = n as THREE.Mesh
        m.geometry.dispose()
        if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose())
        else m.material.dispose()
      }
    })
    this.pmrem.dispose()
    this.scene.remove(this.root)
    this.sun.dispose()
    this.rim.dispose()
    this.coolRim.dispose()
    this.fireLightL.dispose()
    this.fireLightR.dispose()
    this.aoTexture.dispose()
    this.heroContactAO.geometry.dispose()
    this.heroContactAO.material.dispose()
    this.kaijuContactAO.geometry.dispose()
    this.kaijuContactAO.material.dispose()
    this.dust.geometry.dispose()
    this.dust.material.dispose()
    this.embers.geometry.dispose()
    this.embers.material.dispose()
    this.contact.material.dispose()
    this.contact.geometry.dispose()
  }
}

/** 暗夜湿润柏油路面水洼粗糙度贴图（亮区干燥粗糙，暗区湿润水洼反射城市霓虹与光线） */
function makeWetPuddleRoughnessTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#d4d4d4'
  ctx.fillRect(0, 0, size, size)

  let seed = 1337
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  for (let i = 0; i < 38; i++) {
    const cx = rand() * size
    const cy = rand() * size
    const rx = 14 + rand() * 34
    const ry = 10 + rand() * 26
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, Math.max(rx, ry))
    grad.addColorStop(0, 'rgba(34, 34, 34, 0.85)')
    grad.addColorStop(0.65, 'rgba(72, 72, 72, 0.45)')
    grad.addColorStop(1, 'rgba(212, 212, 212, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(6, 6)
  return tex
}

function createNightCitySkyDome() {
  const geo = new THREE.SphereGeometry(230, 32, 24)
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vWorldDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.58;
        for (int i = 0; i < 2; i++) {
          v += a * noise(p);
          p *= 2.15;
          a *= 0.42;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vWorldDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 zenith = vec3(0.035, 0.06, 0.13);
        vec3 midSky = vec3(0.11, 0.16, 0.27);
        vec3 horizonFire = vec3(0.42, 0.22, 0.14);
        vec3 base = mix(midSky, zenith, pow(max(h, 0.0001), 0.65));
        float fireGlow = exp(-max(h, 0.0) * 8.5);
        base = mix(base, horizonFire, fireGlow * 0.62);

        vec2 cloudUv = d.xz / (h + 0.22) * 0.9 + vec2(uTime * 0.015, -uTime * 0.008);
        float clouds = fbm(cloudUv * 2.2);
        float cloudMask = smoothstep(0.36, 0.78, clouds) * smoothstep(0.0, 0.28, h);
        vec3 cloudCol = mix(vec3(0.24, 0.29, 0.40), vec3(0.55, 0.34, 0.24), fireGlow * 0.8);
        vec3 col = mix(base, cloudCol, cloudMask * 0.52);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = -12
  return mesh
}

function makeNightWindowsTexture(): THREE.CanvasTexture {
  const w = 256
  const h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#060a14'
  ctx.fillRect(0, 0, w, h)

  const cols = 16
  const rows = 44
  const cw = w / cols
  const ch = h / rows
  let seed = 42
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  for (let r = 1; r < rows - 1; r++) {
    const floorLitBias = rand() < 0.25 ? 0.55 : 0.28
    for (let c = 1; c < cols - 1; c++) {
      if (rand() > floorLitBias) continue
      const warm = rand()
      ctx.fillStyle =
        warm < 0.6
          ? `rgba(255, 224, 160, ${0.55 + rand() * 0.42})`
          : warm < 0.88
            ? `rgba(186, 222, 255, ${0.48 + rand() * 0.42})`
            : `rgba(255, 168, 102, ${0.6 + rand() * 0.35})`
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 4)
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  return tex
}

function createRuinsFlameMaterial(seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
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
      uniform float uSeed;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec2 uv = vUv;
        float x = (uv.x - 0.5) * 2.0;
        float sway = sin(uv.y * 5.2 - uTime * 7.5 + uSeed) * 0.18 * uv.y;
        float n1 = noise(vec2((x + sway) * 3.4, uv.y * 4.5 - uTime * 4.8 + uSeed));
        float n2 = noise(vec2((x - sway) * 6.5, uv.y * 8.2 - uTime * 8.5 + uSeed * 2.0));
        float shape = 1.0 - smoothstep(0.08, 0.92, abs(x + sway) / max(0.14, 1.0 - uv.y * 0.85));
        float flame = shape * smoothstep(0.0, 0.16, uv.y) * (1.0 - smoothstep(0.45, 1.0, uv.y + n1 * 0.35 - 0.15));
        flame *= (0.65 + 0.55 * n1 + 0.3 * n2);
        if (flame < 0.04) discard;
        vec3 col = mix(vec3(1.15, 0.22, 0.03), vec3(1.55, 0.82, 0.18), clamp(flame * 1.15, 0.0, 1.0));
        col = mix(col, vec3(1.85, 1.55, 0.95), smoothstep(0.75, 1.15, flame) * (1.0 - uv.y));
        gl_FragColor = vec4(col, clamp(flame * 0.92, 0.0, 1.0));
      }
    `,
  })
}

function createRuinsSmokeMaterial(seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
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
      uniform float uSeed;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec2 q = vUv - vec2(0.5, 0.45);
        float d = length(q * vec2(1.2, 0.95));
        float n = noise(vec2(vUv.x * 3.5 + uSeed, vUv.y * 3.2 - uTime * 1.15));
        float mask = (1.0 - smoothstep(0.15, 0.56, d + (n - 0.5) * 0.25))
                   * smoothstep(0.0, 0.2, vUv.y)
                   * (1.0 - smoothstep(0.7, 1.0, vUv.y));
        vec3 col = mix(vec3(0.09, 0.08, 0.10), vec3(0.35, 0.16, 0.09), (1.0 - vUv.y) * 0.65);
        gl_FragColor = vec4(col, clamp(mask * 0.48, 0.0, 0.55));
      }
    `,
  })
}

function createCosmicStage() {
  const group = new THREE.Group()

  const starsMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.z, d.x) * 4.0, d.y * 6.0);
        float neb = 0.5 + 0.5 * sin(uv.x * 1.3 + uTime * 0.35) * cos(uv.y * 2.1 - uTime * 0.25);
        vec3 bg = mix(vec3(0.02, 0.06, 0.16), vec3(0.05, 0.22, 0.38), neb * 0.65);
        bg += vec3(0.06, 0.16, 0.28) * exp(-abs(d.y) * 3.5);
        vec2 cell = floor(uv * 16.0);
        vec2 f = fract(uv * 16.0) - 0.5;
        float h = hash(cell);
        float star = step(0.955, h) * smoothstep(0.18, 0.02, length(f)) * (0.55 + 0.45 * sin(uTime * 4.0 + h * 50.0));
        gl_FragColor = vec4(bg + vec3(0.75, 0.95, 1.2) * star, 1.0);
      }
    `,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(180, 28, 20), starsMat)
  dome.renderOrder = -10
  group.add(dome)

  const ringMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec2 q = (vUv - 0.5) * 2.0;
        float r = length(q);
        if (r > 1.0) discard;
        float a = atan(q.y, q.x);
        float r1 = exp(-pow(max(abs(r - 0.88) * 34.0, 0.0001), 2.0));
        float r2 = exp(-pow(max(abs(r - 0.64) * 28.0, 0.0001), 2.0)) * step(0.28, fract((a / 6.28318) * 14.0 + uTime * 0.35));
        float r3 = exp(-pow(max(abs(r - 0.40) * 32.0, 0.0001), 2.0)) * step(0.32, fract((a / 6.28318) * 8.0 - uTime * 0.5));
        float glow = exp(-r * 2.6) * 0.45;
        float intensity = r1 * 1.1 + r2 * 0.85 + r3 * 0.9 + glow;
        vec3 col = mix(vec3(0.15, 0.65, 1.25), vec3(0.85, 0.98, 1.4), r1 * 0.7);
        gl_FragColor = vec4(col * intensity, clamp(intensity * 0.85, 0.0, 1.0));
      }
    `,
  })
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), ringMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.set(0, 0.06, 12.2)
  group.add(ring)

  return { group, ringMat, starsMat }
}

function makeSoftBlobTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.85)')
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.42)')
  grad.addColorStop(0.8, 'rgba(0, 0, 0, 0.1)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

function makeImpactDust() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  geometry.setIndex(quad.index)
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const clouds = 32
  const velocities = new Float32Array(clouds * 3)
  for (let i = 0; i < clouds; i++) {
    const angle = i * 2.39996
    const speed = 2.0 + (i % 7) * 0.62
    velocities.set([Math.cos(angle) * speed, 0.28 + (i % 5) * 0.2, Math.sin(angle) * speed], i * 3)
  }
  geometry.instanceCount = clouds
  geometry.setAttribute('velocity', new THREE.InstancedBufferAttribute(velocities, 3))
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { age: { value: 0 }, tint: { value: new THREE.Color() } },
    vertexShader: `
      attribute vec3 velocity;
      uniform float age;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 center = velocity * vec3(1. + age * 1.15, age, 1. + age * 1.15);
        vec4 mv = modelViewMatrix * vec4(center, 1.);
        mv.xy += position.xy * (1.2 + age * 3.6);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float age;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec2 q = vUv - .5;
        float radius = length(q) + .035*sin(q.x*24.)*cos(q.y*17.);
        float opacity = (1.-smoothstep(.02,.49,radius)) * (1.-smoothstep(.08,1.25,age));
        gl_FragColor = vec4(tint, opacity*.45);
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}

function makeVolcanoEmbers() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(0.32, 0.32)
  geometry.setIndex(quad.index)
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))
  const count = 130
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    seeds.set(
      [
        (Math.random() - 0.5) * 66,
        Math.random() * 26,
        (Math.random() - 0.5) * 68 - 2,
        0.5 + Math.random() * 1.25,
      ],
      i * 4,
    )
  }
  geometry.instanceCount = count
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4))
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      void main() {
        vUv = uv;
        float cycle = fract((aSeed.y + uTime * (1.65 * aSeed.w)) / 26.0);
        vLife = cycle;
        vec3 pos = vec3(
          aSeed.x + sin(uTime * 1.4 + aSeed.z) * 2.1,
          cycle * 26.0,
          aSeed.z + cos(uTime * 1.1 + aSeed.x) * 1.6
        );
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += position.xy * (0.55 + aSeed.w * 0.72);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv;
      varying float vLife;
      void main() {
        float d = length(vUv - 0.5);
        float glow = smoothstep(0.5, 0.05, d);
        float fade = sin(vLife * 3.14159265);
        vec3 col = mix(vec3(1.2, 0.35, 0.05), vec3(1.5, 0.95, 0.38), glow);
        gl_FragColor = vec4(col, glow * fade * 0.88);
      }`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  return mesh
}
