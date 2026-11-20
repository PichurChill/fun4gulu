import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const BUILDING_URLS = [
  '/models/ultraman/city/building-skyscraper-a.glb',
  '/models/ultraman/city/building-skyscraper-b.glb',
  '/models/ultraman/city/building-skyscraper-c.glb',
  '/models/ultraman/city/building-skyscraper-d.glb',
  '/models/ultraman/city/building-g.glb',
]

/**
 * 构建阳光海港集装箱城市战场（贴合商场特摄机台：明亮蓝天、海港远山、摩天大楼、彩色集装箱堆场、黄色龙门吊）
 */
export class HarborArena {
  public readonly group = new THREE.Group()
  private seaMesh: THREE.Mesh | null = null
  private clouds: THREE.Group[] = []

  constructor(scene: THREE.Scene) {
    this.group.name = 'HarborArena'
    scene.add(this.group)
    this.buildSkyAndLighting(scene)
    this.buildGroundAndHarbor()
    this.buildContainersAndCranes()
    this.buildMountainsAndSea()
    this.buildClouds()
  }

  private buildSkyAndLighting(scene: THREE.Scene) {
    scene.background = new THREE.Color(0x6ec3f8)
    scene.fog = new THREE.FogExp2(0x9bd7fb, 0.0036)

    // 天空渐变穹顶
    const skyGeo = new THREE.SphereGeometry(280, 24, 16)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x1f7ae0) },
        horizonColor: { value: new THREE.Color(0xbce6ff) },
        warmGlow: { value: new THREE.Color(0xfff1d6) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 warmGlow;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos).y;
          float t = clamp(pow(max(h, 0.0), 0.55), 0.0, 1.0);
          vec3 col = mix(horizonColor, topColor, t);
          float sunMask = smoothstep(0.65, 1.0, dot(normalize(vWorldPos), normalize(vec3(0.45, 0.35, -0.82))));
          col = mix(col, warmGlow, sunMask * 0.45);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    this.group.add(new THREE.Mesh(skyGeo, skyMat))

    // 半球环境光 + 主日光（投射立体阴影）+ 迪迦背部轮廓补光
    const hemiLight = new THREE.HemisphereLight(0xd9f0ff, 0x6b7280, 1.15)
    this.group.add(hemiLight)

    const sunLight = new THREE.DirectionalLight(0xfff5e4, 2.2)
    sunLight.position.set(36, 54, 42)
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(1024, 1024)
    sunLight.shadow.camera.near = 10
    sunLight.shadow.camera.far = 160
    sunLight.shadow.camera.left = -45
    sunLight.shadow.camera.right = 45
    sunLight.shadow.camera.top = 45
    sunLight.shadow.camera.bottom = -45
    sunLight.shadow.bias = -0.0005
    this.group.add(sunLight)

    // 侧后冷白轮廓光，让第三人称迪迦背部装甲与怪兽剪影更立体
    const rimLight = new THREE.DirectionalLight(0xa3dcff, 0.9)
    rimLight.position.set(-28, 22, -32)
    this.group.add(rimLight)
  }

  private buildGroundAndHarbor() {
    // 码头水泥战斗广场
    const plazaGeo = new THREE.PlaneGeometry(160, 130)
    const plazaMat = new THREE.MeshStandardMaterial({
      color: 0x7a808a,
      roughness: 0.92,
      metalness: 0.05,
    })
    const plaza = new THREE.Mesh(plazaGeo, plazaMat)
    plaza.rotation.x = -Math.PI / 2
    plaza.position.set(0, 0, 8)
    plaza.receiveShadow = true
    this.group.add(plaza)

    // 战斗中心大道沥青路与黄色标线（引导视觉聚焦怪兽与迪迦）
    const roadGeo = new THREE.PlaneGeometry(24, 86)
    const roadMat = new THREE.MeshStandardMaterial({
      color: 0x454a54,
      roughness: 0.95,
    })
    const road = new THREE.Mesh(roadGeo, roadMat)
    road.rotation.x = -Math.PI / 2
    road.position.set(0, 0.03, 6)
    road.receiveShadow = true
    this.group.add(road)

    // 道路虚线
    const dashGeo = new THREE.PlaneGeometry(0.55, 3.6)
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 })
    for (let z = -30; z <= 36; z += 7.5) {
      const dash = new THREE.Mesh(dashGeo, dashMat)
      dash.rotation.x = -Math.PI / 2
      dash.position.set(0, 0.05, z)
      this.group.add(dash)
    }

    // 码头防波堤边缘黄黑警示坎
    const quayGeo = new THREE.BoxGeometry(160, 1.8, 3.2)
    const quayMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.85 })
    const quay = new THREE.Mesh(quayGeo, quayMat)
    quay.position.set(0, 0.4, -56)
    quay.receiveShadow = true
    this.group.add(quay)
  }

  private buildContainersAndCranes() {
    // 彩色港口集装箱堆场（位于战场中景左右两侧，不挡主视线）
    const containerGeo = new THREE.BoxGeometry(5.8, 2.7, 2.5)
    const palette = [0xd9483b, 0x2563eb, 0xf59e0b, 0x10b981, 0xe5e7eb, 0x0284c7]
    const materials = palette.map(
      (hex) =>
        new THREE.MeshStandardMaterial({
          color: hex,
          roughness: 0.62,
          metalness: 0.28,
        }),
    )

    const stacks: Array<[number, number, number, number, number]> = [
      // [x, z, layers, rotY, colorOffset]
      [-18, -16, 2, 0.05, 0],
      [-24, -18, 3, -0.02, 1],
      [-20, -25, 2, 0.1, 2],
      [-30, -24, 3, 0, 3],
      [-17, -34, 2, -0.06, 4],
      [-26, -36, 3, 0.04, 5],
      [18, -15, 2, -0.05, 2],
      [24, -18, 3, 0.03, 0],
      [21, -26, 2, -0.08, 1],
      [29, -25, 3, 0.02, 4],
      [19, -35, 2, 0.05, 5],
      [28, -37, 2, -0.03, 3],
      [-22, 2, 2, 0.02, 1],
      [22, 4, 2, -0.04, 0],
    ]

    stacks.forEach(([x, z, layers, rotY, offset], idx) => {
      for (let l = 0; l < layers; l++) {
        const mat = materials[(offset + l + idx) % materials.length]!
        const mesh = new THREE.Mesh(containerGeo, mat)
        mesh.position.set(x, 1.35 + l * 2.72, z)
        mesh.rotation.y = rotY
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
    })

    // 两座经典港口大型黄色/橙色龙门吊（致敬照片中的码头天际线）
    this.addPortCrane(-26, -42, 0.12, 0xf59e0b)
    this.addPortCrane(26, -44, -0.18, 0xea580c)
  }

  private addPortCrane(x: number, z: number, rotY: number, colorHex: number) {
    const crane = new THREE.Group()
    crane.position.set(x, 0, z)
    crane.rotation.y = rotY

    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.55,
      metalness: 0.35,
    })

    // 四根支架腿
    const legGeo = new THREE.BoxGeometry(1.1, 22, 1.1)
    const legCoords: Array<[number, number]> = [
      [-4.2, -3.2],
      [4.2, -3.2],
      [-4.2, 3.2],
      [4.2, 3.2],
    ]
    for (const [lx, lz] of legCoords) {
      const leg = new THREE.Mesh(legGeo, mat)
      leg.position.set(lx, 11, lz)
      leg.castShadow = true
      crane.add(leg)
    }

    // 顶部横向巨型吊臂
    const boomGeo = new THREE.BoxGeometry(24, 1.6, 2.2)
    const boom = new THREE.Mesh(boomGeo, mat)
    boom.position.set(2, 21.5, 0)
    boom.castShadow = true
    crane.add(boom)

    // 横梁加固
    const crossGeo = new THREE.BoxGeometry(9.6, 1.2, 7.2)
    const cross = new THREE.Mesh(crossGeo, mat)
    cross.position.set(0, 14, 0)
    crane.add(cross)

    this.group.add(crane)
  }

  private buildMountainsAndSea() {
    // 碧蓝海面（位于防波堤之外）
    const seaGeo = new THREE.PlaneGeometry(420, 220)
    const seaMat = new THREE.MeshStandardMaterial({
      color: 0x1ca3ec,
      roughness: 0.22,
      metalness: 0.32,
    })
    this.seaMesh = new THREE.Mesh(seaGeo, seaMat)
    this.seaMesh.rotation.x = -Math.PI / 2
    this.seaMesh.position.set(0, -0.6, -165)
    this.group.add(this.seaMesh)

    // 远方淡蓝海湾山脉剪影
    const mtMat = new THREE.MeshStandardMaterial({
      color: 0x6ea8dc,
      roughness: 0.95,
    })
    const peaks: Array<[number, number, number, number]> = [
      [-95, -185, 58, 38],
      [-40, -195, 65, 46],
      [25, -190, 52, 32],
      [95, -180, 62, 42],
    ]
    for (const [px, pz, radius, height] of peaks) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 7), mtMat)
      cone.position.set(px, height / 2 - 2, pz)
      this.group.add(cone)
    }
  }

  private buildClouds() {
    const cloudMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
    })
    const cloudDefs: Array<[number, number, number, number]> = [
      [-65, 52, -110, 1.4],
      [-15, 60, -135, 1.8],
      [50, 54, -120, 1.5],
      [105, 48, -95, 1.2],
    ]
    for (const [cx, cy, cz, scale] of cloudDefs) {
      const g = new THREE.Group()
      g.position.set(cx, cy, cz)
      g.scale.setScalar(scale)
      const puffs: Array<[number, number, number, number]> = [
        [0, 0, 0, 7.5],
        [-6.5, -1, 1, 5.5],
        [6.8, -0.8, -0.5, 5.8],
        [2.2, 2.2, 0.5, 5.2],
      ]
      for (const [x, y, z, r] of puffs) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat)
        m.position.set(x, y, z)
        m.scale.set(1.4, 0.65, 0.9)
        g.add(m)
      }
      this.group.add(g)
      this.clouds.push(g)
    }
  }

  /** 异步加载 Kenney CC0 城市建筑环绕在海港两侧（不阻挡核心战斗通道） */
  public async loadCityBuildings(loader: GLTFLoader): Promise<void> {
    const templates = await Promise.all(
      BUILDING_URLS.map(async (url) => {
        try {
          const gltf = await loader.loadAsync(url)
          return gltf.scene
        } catch {
          return null
        }
      }),
    )
    const validTemplates = templates.filter((t): t is THREE.Group => t !== null)
    if (validTemplates.length === 0) return

    const placements: Array<[number, number, number, number, number]> = [
      // [x, z, scale, rotY, templateIdx]
      [-34, 18, 6.2, Math.PI * 0.5, 0],
      [-40, 2, 7.5, Math.PI * 0.5, 1],
      [-42, -14, 8.2, Math.PI * 0.5, 2],
      [-46, -32, 7.0, 0, 3],
      [-54, -46, 9.0, 0, 4],
      [-28, 30, 5.5, Math.PI * 0.5, 4],
      [34, 16, 6.4, -Math.PI * 0.5, 1],
      [40, 0, 7.8, -Math.PI * 0.5, 0],
      [42, -16, 8.5, -Math.PI * 0.5, 3],
      [46, -34, 7.2, 0, 2],
      [54, -48, 8.8, 0, 4],
      [30, 30, 5.8, -Math.PI * 0.5, 0],
      // 远端海湾天际线高楼剪影
      [-70, -85, 12, 0, 2],
      [-50, -95, 13, 0, 1],
      [52, -92, 13, 0, 0],
      [74, -84, 11.5, 0, 3],
    ]

    for (const [x, z, scale, rotY, idx] of placements) {
      const tpl = validTemplates[idx % validTemplates.length]!
      const clone = tpl.clone(true)
      clone.scale.setScalar(scale)
      clone.position.set(x, 0, z)
      clone.rotation.y = rotY
      clone.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const mesh = node as THREE.Mesh
          mesh.castShadow = false
          mesh.receiveShadow = true
        }
      })
      this.group.add(clone)
    }
  }

  public update(dt: number, elapsedTime: number) {
    if (this.seaMesh) {
      this.seaMesh.position.y = -0.6 + Math.sin(elapsedTime * 1.2) * 0.14
    }
    for (const c of this.clouds) {
      c.position.x += dt * 1.1
      if (c.position.x > 160) c.position.x = -160
    }
  }
}
