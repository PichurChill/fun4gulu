import * as THREE from 'three'

/** 擂台半宽（世界单位）： fighters 活动范围 [-ARENA_HALF_X, ARENA_HALF_X] */
export const ARENA_HALF_X = 22

/**
 * 横版格斗夜景擂台：霓虹都市天际线 + 街道 + 探照灯 + 星月背景
 * 全部程序化生成，无外部资源依赖；镜头固定朝 -Z 侧视擂台
 */
export class DuelStage {
  private readonly group = new THREE.Group()
  private readonly searchLights: THREE.Mesh[] = []
  private readonly moonHalo: THREE.Mesh
  private readonly starPoints: THREE.Points

  constructor(scene: THREE.Scene) {
    this.group.name = 'DuelStage'
    scene.add(this.group)

    scene.background = new THREE.Color(0x070d1f)
    scene.fog = new THREE.Fog(0x070d1f, 90, 240)

    // ---- 灯光 ----
    const hemi = new THREE.HemisphereLight(0x93b8ff, 0x141a2e, 0.75)
    this.group.add(hemi)

    const key = new THREE.DirectionalLight(0xdfe9ff, 1.65)
    key.position.set(18, 42, 30)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -34
    key.shadow.camera.right = 34
    key.shadow.camera.top = 40
    key.shadow.camera.bottom = -6
    key.shadow.camera.far = 140
    key.shadow.bias = -0.0006
    this.group.add(key)

    const rimA = new THREE.DirectionalLight(0x38e8ff, 0.5)
    rimA.position.set(-30, 16, -18)
    this.group.add(rimA)
    const rimB = new THREE.DirectionalLight(0x7df9ff, 0.4)
    rimB.position.set(30, 14, -18)
    this.group.add(rimB)

    // ---- 街道地面 ----
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 260),
      new THREE.MeshStandardMaterial({ color: 0x1a2138, roughness: 0.94, metalness: 0.05 }),
    )
    asphalt.rotation.x = -Math.PI / 2
    asphalt.position.set(0, 0, -60)
    asphalt.receiveShadow = true
    this.group.add(asphalt)

    // 擂台中心发光对战区
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x232f52,
      roughness: 0.6,
      metalness: 0.3,
      emissive: 0x0e1a3a,
      emissiveIntensity: 1.0,
    })
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF_X * 2 + 8, 34), ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(0, 0.02, 0)
    ring.receiveShadow = true
    this.group.add(ring)

    // 擂台边界霓虹线与立柱
    for (const sx of [-1, 1]) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.1, 34),
        new THREE.MeshBasicMaterial({
          color: sx < 0 ? 0x38e8ff : 0x7df9ff,
          transparent: true,
          opacity: 0.85,
        }),
      )
      line.position.set(sx * (ARENA_HALF_X + 3.5), 0.06, 0)
      this.group.add(line)

      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.9, 26, 10),
        new THREE.MeshStandardMaterial({
          color: 0x101830,
          emissive: sx < 0 ? 0x1899bb : 0x3ecbd6,
          emissiveIntensity: 1.4,
          roughness: 0.4,
        }),
      )
      pillar.position.set(sx * (ARENA_HALF_X + 3.5), 13, -14)
      this.group.add(pillar)
    }

    // ---- 星空 ----
    const starGeo = new THREE.BufferGeometry()
    const starCount = 320
    const starPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.42
      const r = 200
      starPos[i * 3] = Math.cos(theta) * Math.cos(phi) * r
      starPos[i * 3 + 1] = Math.sin(phi) * r + 20
      starPos[i * 3 + 2] = Math.sin(theta) * Math.cos(phi) * r - 60
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    this.starPoints = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xbfd4ff, size: 0.9, sizeAttenuation: true, fog: false }),
    )
    this.group.add(this.starPoints)

    // ---- 月亮与光晕（不受雾衰减，保持夜空可读） ----
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(7, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xf2f6ff, fog: false }),
    )
    moon.position.set(-58, 52, -150)
    this.group.add(moon)
    this.moonHalo = new THREE.Mesh(
      new THREE.CircleGeometry(15, 28),
      new THREE.MeshBasicMaterial({
        color: 0x9fb8ff,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    )
    this.moonHalo.position.set(-58, 52, -150.5)
    this.group.add(this.moonHalo)

    // ---- 霓虹天际线（程序化生成，远近两层） ----
    const windowTex = this.createWindowTexture()
    for (let layer = 0; layer < 2; layer++) {
      const zBase = layer === 0 ? -88 : -46
      const spanX = layer === 0 ? 320 : 180
      const maxHeight = layer === 0 ? 58 : 34
      const count = layer === 0 ? 16 : 12
      for (let i = 0; i < count; i++) {
        const w = 10 + Math.random() * 16
        const h = 12 + Math.random() * maxHeight
        const d = 10 + Math.random() * 14
        const tex = windowTex.clone()
        tex.needsUpdate = true
        tex.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(2, Math.round(h / 5)))

        const building = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshStandardMaterial({
            color: layer === 0 ? 0x0c1226 : 0x121a33,
            roughness: 0.85,
            metalness: 0.2,
            emissive: 0xffffff,
            emissiveMap: tex,
            emissiveIntensity: layer === 0 ? 0.5 : 0.75,
          }),
        )
        building.position.set(
          -spanX / 2 + (i + 0.5) * (spanX / count) + (Math.random() - 0.5) * 8,
          h / 2,
          zBase + (Math.random() - 0.5) * 16,
        )
        this.group.add(building)
      }
    }

    // ---- 双探照灯（特摄氛围，缓慢摇摆） ----
    for (const sx of [-1, 1]) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(5.5, 90, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: sx < 0 ? 0x38e8ff : 0x7df9ff,
          transparent: true,
          opacity: 0.09,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      cone.geometry.translate(0, -45, 0)
      cone.position.set(sx * 34, 40, -30)
      this.group.add(cone)
      this.searchLights.push(cone)
    }
  }

  /** 生成楼体亮灯窗户纹理 */
  private createWindowTexture(): THREE.Texture {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 32, 64)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        if (Math.random() < 0.42) {
          const lit = Math.random()
          ctx.fillStyle =
            lit < 0.6 ? '#ffd98a' : lit < 0.85 ? '#9fd8ff' : '#ff9db4'
          ctx.fillRect(x * 4 + 1, y * 4 + 1, 2, 2)
        }
      }
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.magFilter = THREE.NearestFilter
    return tex
  }

  public update(dt: number, elapsed: number) {
    // 探照灯缓慢摇摆扫过擂台
    this.searchLights.forEach((cone, idx) => {
      const phase = elapsed * 0.35 + idx * Math.PI
      cone.rotation.z = Math.sin(phase) * 0.55
      cone.rotation.x = 0.35 + Math.cos(phase * 0.7) * 0.18
    })
    const haloMat = this.moonHalo.material as THREE.MeshBasicMaterial
    haloMat.opacity = 0.24 + Math.sin(elapsed * 0.8) * 0.05
  }

  public dispose() {
    this.group.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh
        mesh.geometry.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          const mat = m as THREE.Material & { map?: THREE.Texture; emissiveMap?: THREE.Texture }
          mat.map?.dispose()
          mat.emissiveMap?.dispose()
          mat.dispose()
        }
      }
    })
    this.starPoints.geometry.dispose()
    ;(this.starPoints.material as THREE.Material).dispose()
    this.group.parent?.remove(this.group)
  }
}
