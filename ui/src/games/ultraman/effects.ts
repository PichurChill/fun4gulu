import * as THREE from 'three'
import type { HeroProfile } from './heroes'

interface SparkParticle {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  gravity: number
  baseWidth: number
  lengthFactor: number
}

interface ShockwaveRing {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  life: number
  maxLife: number
  maxRadius: number
}

interface HitFlare {
  mesh: THREE.Sprite
  life: number
  maxLife: number
  peakScale: number
  spinSpeed: number
}

export interface Projectile {
  kind: 'punch-wave' | 'kick-wave' | 'ultra-disc' | 'kaiju-fireball'
  mesh: THREE.Object3D
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  damage: number
  age: number
  maxAge: number
  fromHero: boolean
  punchSide?: 'left' | 'right'
  finisher?: boolean
  hitTriggered: boolean
}

function makeStarFlareTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const half = size / 2

  // 柔和核心光晕
  const rad = ctx.createRadialGradient(half, half, 0, half, half, half)
  rad.addColorStop(0, 'rgba(255,255,255,1)')
  rad.addColorStop(0.18, 'rgba(255,255,255,0.85)')
  rad.addColorStop(0.45, 'rgba(255,255,255,0.22)')
  rad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = rad
  ctx.fillRect(0, 0, size, size)

  // 锐利十字星芒
  ctx.save()
  ctx.translate(half, half)
  for (let i = 0; i < 2; i++) {
    ctx.rotate(Math.PI / 2)
    const beam = ctx.createLinearGradient(-half, 0, half, 0)
    beam.addColorStop(0, 'rgba(255,255,255,0)')
    beam.addColorStop(0.5, 'rgba(255,255,255,0.95)')
    beam.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = beam
    ctx.beginPath()
    ctx.ellipse(0, 0, half * 0.95, 3.2, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeStreakSparkTexture(): THREE.CanvasTexture {
  const w = 32
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(w / 2, h * 0.38, 1, w / 2, h / 2, h / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.28, 'rgba(255,255,255,0.88)')
  grad.addColorStop(0.7, 'rgba(255,255,255,0.2)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.save()
  ctx.scale(1, h / w)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(w / 2, w / 2, w / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function createPlasmaBeamMaterial(initialColor: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(initialColor) },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uCoreTightness: { value: 2.2 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uFade;
      uniform float uCoreTightness;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        float facing = abs(dot(normalize(vWorldNormal), normalize(vViewDir)));
        float outerGlow = pow(facing, 1.35);
        float hotCore = pow(facing, uCoreTightness * 2.1);
        float flow = 0.82 + 0.18 * sin(vUv.y * 34.0 - uTime * 46.0)
                          + 0.10 * cos(vUv.y * 19.0 - uTime * 28.0 + vUv.x * 6.28318);
        float tipSoft = smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.92, 1.0, vUv.y));
        vec3 col = mix(uColor, vec3(1.0, 0.99, 0.94), hotCore * 0.92);
        float alpha = (outerGlow * 0.72 + hotCore * 0.55) * flow * tipSoft * uFade;
        gl_FragColor = vec4(col * (1.15 + hotCore * 0.6), clamp(alpha, 0.0, 1.0));
      }
    `,
  })
}

/**
 * 新一代 3D 特摄特效系统：
 * - 等离子羽化光线束（支持宿命双光线对波 Beam Clash！）
 * - 沿速度方向高速拉伸的特摄电光火花条（Streak Sparks）
 * - 极薄刀锋震波细环（Razor Shockwave）与十字星芒爆点
 * - 六边形力场能量穹盾与全息扫描地面危险法阵
 */
export class BattleEffects {
  private readonly group = new THREE.Group()
  private sparks: SparkParticle[] = []
  private shockwaves: ShockwaveRing[] = []
  private flares: HitFlare[] = []
  public projectiles: Projectile[] = []

  private readonly sparkQuadGeo = new THREE.PlaneGeometry(1, 1)
  private readonly shockwaveGeo = new THREE.PlaneGeometry(2, 2)
  private readonly flareTex: THREE.CanvasTexture
  private readonly sparkTex: THREE.CanvasTexture

  // 英雄等离子光线组
  private readonly heroBeamGroup = new THREE.Group()
  private readonly heroBeamInner: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly heroBeamOuter: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly heroBeamFilaments: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = []
  private readonly heroMuzzleSprite: THREE.Sprite
  private readonly heroImpactSprite: THREE.Sprite
  private heroBeamActive = false
  private heroBeamSuper = false
  private heroBeamColorHex = 0x38d9ff
  private heroBeamTime = 0
  private heroBeamDuration = 1.4

  // 怪兽暗黑破坏光线 & 蓄力能量球
  private readonly kaijuBeamGroup = new THREE.Group()
  private readonly kaijuBeamInner: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private readonly kaijuBeamOuter: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
  private kaijuBeamTime = 0
  private kaijuBeamDuration = 0.75
  private readonly kaijuChargeSprite: THREE.Sprite

  // 双光线对波交汇奇点球
  private readonly clashGroup = new THREE.Group()
  private readonly clashCore: THREE.Mesh
  private readonly clashFlare: THREE.Sprite
  private clashActive = false
  private clashProgress = 0.5

  // 六边形蜂窝能量护盾
  private readonly shieldMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private shieldFlash = 0

  // 英雄蓄力预览
  private readonly chargeSprite: THREE.Sprite
  private readonly chargeDiscPreview: THREE.Group
  private readonly typeChargeSprite: THREE.Sprite

  // 全息扫描地面危险预警阵
  private readonly warningRing: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>

  private readonly upAxis = new THREE.Vector3(0, 1, 0)
  private readonly tmpDir = new THREE.Vector3()

  private themeBeamColor = 0x38d9ff
  private themeBeamSuperColor = 0xfacc15
  private themeDiscColor = 0x38e8ff
  private themeBurstColor = 0x67e8f9

  constructor(scene: THREE.Scene) {
    this.group.name = 'BattleEffects'
    scene.add(this.group)

    this.flareTex = makeStarFlareTexture()
    this.sparkTex = makeStreakSparkTexture()

    // 1. 英雄等离子光线
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true)
    this.heroBeamInner = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xffffff))
    this.heroBeamInner.material.uniforms.uCoreTightness!.value = 3.2
    this.heroBeamOuter = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0x38d9ff))
    this.heroBeamOuter.material.uniforms.uCoreTightness!.value = 1.4
    this.heroBeamGroup.add(this.heroBeamInner, this.heroBeamOuter)

    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(
        cylGeo,
        new THREE.MeshBasicMaterial({
          color: i % 2 === 0 ? 0xe0f7ff : 0xfef08a,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      this.heroBeamGroup.add(f)
      this.heroBeamFilaments.push(f)
    }

    this.heroMuzzleSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xe0f7ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroImpactSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0x7dd3fc,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroBeamGroup.add(this.heroMuzzleSprite, this.heroImpactSprite)
    this.heroBeamGroup.visible = false
    this.group.add(this.heroBeamGroup)

    // 2. 怪兽暗黑破坏光线 & 蓄力球
    this.kaijuBeamInner = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xffd6ff))
    this.kaijuBeamInner.material.uniforms.uCoreTightness!.value = 3.0
    this.kaijuBeamOuter = new THREE.Mesh(cylGeo, createPlasmaBeamMaterial(0xa855f7))
    this.kaijuBeamOuter.material.uniforms.uCoreTightness!.value = 1.35
    this.kaijuBeamGroup.add(this.kaijuBeamInner, this.kaijuBeamOuter)
    this.kaijuBeamGroup.visible = false
    this.group.add(this.kaijuBeamGroup)

    this.kaijuChargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xff6b35,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.kaijuChargeSprite.visible = false
    this.group.add(this.kaijuChargeSprite)

    // 3. 双光线对波奇点球
    this.clashCore = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.clashFlare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xfef08a,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.clashGroup.add(this.clashCore, this.clashFlare)
    this.clashGroup.visible = false
    this.group.add(this.clashGroup)

    // 4. 六边形蜂窝能量力场护盾
    this.shieldMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(9.6, 10.6),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uColor: { value: new THREE.Color(0x38bdf8) },
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
          uniform float uFlash;
          uniform vec3 uColor;
          varying vec2 vUv;

          // 六边形距离函数
          float hexDist(vec2 p) {
            p = abs(p);
            return max(dot(p, normalize(vec2(1.0, 1.73205))), p.x);
          }

          void main() {
            vec2 q = (vUv - 0.5) * 2.0;
            // 六边形外框裁剪
            float outerHex = hexDist(q * vec2(1.05, 0.95));
            if (outerHex > 0.96) discard;

            // 内部蜂窝晶格纹理
            vec2 gv = q * 7.5;
            vec2 r = vec2(1.0, 1.73205);
            vec2 h = r * 0.5;
            vec2 a = mod(gv, r) - h;
            vec2 b = mod(gv - h, r) - h;
            vec2 cell = dot(a, a) < dot(b, b) ? a : b;
            float cellEdge = smoothstep(0.42, 0.49, hexDist(cell));

            float rim = smoothstep(0.68, 0.95, outerHex);
            float scan = 0.5 + 0.5 * sin(q.y * 10.0 - uTime * 8.0);
            vec3 baseCol = mix(uColor, vec3(1.0, 0.95, 0.65), uFlash * 0.85);
            float alpha = (0.14 + cellEdge * 0.28 * scan + rim * 0.72) * (0.85 + uFlash * 0.65);
            gl_FragColor = vec4(baseCol * (1.1 + rim * 0.5), clamp(alpha, 0.0, 1.0));
          }
        `,
      }),
    )
    this.shieldMesh.visible = false
    this.group.add(this.shieldMesh)

    // 5. 英雄蓄力星芒与光轮预览
    this.chargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0x38e8ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.chargeSprite.visible = false
    this.group.add(this.chargeSprite)

    this.chargeDiscPreview = this.createSawDiscMesh(1.7)
    this.chargeDiscPreview.visible = false
    this.group.add(this.chargeDiscPreview)

    this.typeChargeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: 0xc084fc,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.typeChargeSprite.visible = false
    this.group.add(this.typeChargeSprite)

    // 6. 全息扫描地面危险预警法阵（告别生硬红圆饼）
    this.warningRing = new THREE.Mesh(
      new THREE.PlaneGeometry(11.5, 11.5),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uUrgency: { value: 0 },
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
          uniform float uUrgency;
          varying vec2 vUv;
          void main() {
            vec2 q = (vUv - 0.5) * 2.0;
            float r = length(q);
            if (r > 1.0) discard;
            float angle = atan(q.y, q.x);
            // 外圈旋转分段刻度线
            float dash = step(0.35, fract((angle / 6.28318) * 16.0 + uTime * 0.8));
            float outerRing = smoothstep(0.86, 0.91, r) * (1.0 - smoothstep(0.94, 0.99, r)) * dash;
            // 随倒计时向圆心收缩的高亮锁定环
            float lockR = mix(0.88, 0.16, clamp(uUrgency, 0.0, 1.0));
            float innerLock = exp(-pow((r - lockR) * 26.0, 2.0));
            float softFill = (1.0 - smoothstep(0.0, 0.92, r)) * 0.12 * (0.6 + 0.4 * sin(uTime * 16.0));
            vec3 col = mix(vec3(1.0, 0.28, 0.18), vec3(1.0, 0.88, 0.32), innerLock * 0.7);
            float alpha = clamp(outerRing * 0.85 + innerLock * 0.95 + softFill, 0.0, 1.0);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      }),
    )
    this.warningRing.rotation.x = -Math.PI / 2
    this.warningRing.position.set(0, 0.08, 13.2)
    this.warningRing.visible = false
    this.group.add(this.warningRing)
  }

  public setHeroTheme(profile: HeroProfile) {
    this.themeBeamColor = profile.beamColor
    this.themeBeamSuperColor = profile.beamSuperColor
    this.themeDiscColor = profile.discColor
    this.themeBurstColor = profile.burstColor
    this.chargeSprite.material.color.setHex(profile.accentColor)
    this.shieldMesh.material.uniforms.uColor!.value.setHex(profile.accentColor)
    this.chargeDiscPreview.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mat = (node as THREE.Mesh).material
        if (mat instanceof THREE.MeshBasicMaterial && node.name === 'discOuter') {
          mat.color.setHex(profile.discColor)
        }
      }
    })
  }

  private createSawDiscMesh(radius: number): THREE.Group {
    const g = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.42, radius, 32),
      new THREE.MeshBasicMaterial({
        color: this.themeDiscColor,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    ring.name = 'discOuter'
    ring.rotation.x = -Math.PI / 2
    const core = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.15, radius * 0.52, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    core.rotation.x = -Math.PI / 2
    g.add(ring, core)

    const toothGeo = new THREE.ConeGeometry(radius * 0.18, radius * 0.52, 4)
    const toothMat = new THREE.MeshBasicMaterial({
      color: 0xe0f7ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const tooth = new THREE.Mesh(toothGeo, toothMat)
      tooth.position.set(Math.cos(a) * radius * 1.04, 0, Math.sin(a) * radius * 1.04)
      tooth.rotation.z = -Math.PI / 2
      tooth.rotation.y = -a + 0.35
      g.add(tooth)
    }
    return g
  }

  public startHeroBeam(isSuper: boolean, durationOverride?: number) {
    this.heroBeamActive = true
    this.heroBeamSuper = isSuper
    this.heroBeamTime = 0
    this.heroBeamDuration = durationOverride ?? (isSuper ? 1.75 : 1.25)
    this.heroBeamGroup.visible = true
    const colorHex = isSuper ? this.themeBeamSuperColor : this.themeBeamColor
    this.heroBeamColorHex = colorHex
    this.heroBeamOuter.material.uniforms.uColor!.value.setHex(colorHex)
    this.heroBeamInner.material.uniforms.uColor!.value.setHex(0xffffff)
    this.heroImpactSprite.material.color.setHex(isSuper ? 0xfef08a : colorHex)
  }

  public stopHeroBeam() {
    this.heroBeamActive = false
    this.heroBeamGroup.visible = false
  }

  public isHeroBeamActive(): boolean {
    return this.heroBeamActive
  }

  public startKaijuBeam(accentColor: number, duration = 0.78) {
    this.kaijuBeamTime = 0.001
    this.kaijuBeamDuration = duration
    this.kaijuBeamGroup.visible = true
    this.kaijuBeamOuter.material.uniforms.uColor!.value.setHex(accentColor)
  }

  public stopKaijuBeam() {
    this.kaijuBeamTime = 0
    this.kaijuBeamGroup.visible = false
  }

  /** 更新双光线宿命对波视觉状态 */
  public setBeamClash(active: boolean, progress: number) {
    this.clashActive = active
    this.clashProgress = THREE.MathUtils.clamp(progress, 0.08, 0.95)
    this.clashGroup.visible = active
  }

  public updateKaijuChargeOrb(
    visible: boolean,
    pos: THREE.Vector3,
    progress: number,
    colorHex: number,
    elapsed: number,
  ) {
    this.kaijuChargeSprite.visible = visible
    if (!visible) return
    this.kaijuChargeSprite.position.copy(pos)
    this.kaijuChargeSprite.material.color.setHex(colorHex)
    this.kaijuChargeSprite.material.rotation = elapsed * 4.5
    const s = (1.2 + progress * 4.2) * (0.9 + 0.14 * Math.sin(elapsed * 24))
    this.kaijuChargeSprite.scale.set(s, s, 1)
  }

  /** 发射出拳高速破空光弧（速度更快，贴合近战踏步瞬间命中） */
  public spawnPunchWave(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    damage: number,
    side: 'left' | 'right',
    finisher: boolean,
  ) {
    const radius = finisher ? 1.55 : 0.95
    const wave = new THREE.Mesh(
      new THREE.TorusGeometry(radius, finisher ? 0.18 : 0.11, 8, 28, Math.PI * 1.35),
      new THREE.MeshBasicMaterial({
        color: finisher ? 0xffd166 : this.themeBurstColor,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    wave.position.copy(origin)
    wave.lookAt(target)
    wave.rotation.z = side === 'left' ? -0.45 : Math.PI + 0.45
    this.group.add(wave)

    const vel = target.clone().sub(origin).multiplyScalar(1 / 0.075)
    this.projectiles.push({
      kind: 'punch-wave',
      punchSide: side,
      finisher,
      mesh: wave,
      pos: origin.clone(),
      vel,
      radius: 2.8,
      damage,
      age: 0,
      maxAge: 0.45,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 发射奥特飞踢烈焰旋风斩 */
  public spawnKickWave(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const grp = new THREE.Group()
    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.18, 8, 24),
      new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(0.88, 0.12, 8, 20),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    grp.add(outer, inner)
    grp.position.copy(origin)
    grp.lookAt(target)
    this.group.add(grp)

    const vel = target.clone().sub(origin).multiplyScalar(1 / 0.095)
    this.projectiles.push({
      kind: 'kick-wave',
      mesh: grp,
      pos: origin.clone(),
      vel,
      radius: 3.2,
      damage,
      age: 0,
      maxAge: 0.55,
      fromHero: true,
      hitTriggered: false,
    })
  }

  public spawnUltraDisc(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const disc = this.createSawDiscMesh(2.2)
    disc.position.copy(origin)
    this.group.add(disc)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(64)
    this.projectiles.push({
      kind: 'ultra-disc',
      mesh: disc,
      pos: origin.clone(),
      vel,
      radius: 3.4,
      damage,
      age: 0,
      maxAge: 1.1,
      fromHero: true,
      hitTriggered: false,
    })
  }

  public spawnKaijuFireball(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    colorHex: number,
    damage: number,
  ) {
    const fireball = new THREE.Group()
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xfffbeb }),
    )
    const outer = new THREE.Mesh(
      new THREE.SphereGeometry(1.75, 14, 12),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: colorHex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    halo.scale.set(5.2, 5.2, 1)
    fireball.add(inner, outer, halo)
    fireball.position.copy(origin)
    this.group.add(fireball)

    // 速度适中（25 单位/秒），在近战距离下留出充足反应窗口供玩家侧闪、格挡或挥拳打爆
    const vel = target.clone().sub(origin).normalize().multiplyScalar(25)
    this.projectiles.push({
      kind: 'kaiju-fireball',
      mesh: fireball,
      pos: origin.clone(),
      vel,
      radius: 2.5,
      damage,
      age: 0,
      maxAge: 2.2,
      fromHero: false,
      hitTriggered: false,
    })
  }

  /** 生成特摄电光火石拉伸火花条（沿飞溅速度方向锐利拉长，彻底告别圆波点） */
  public spawnBurst(
    pos: THREE.Vector3,
    colorHex: number,
    count = 16,
    speed = 22,
    scale = 1.0,
  ) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.sparkTex,
        color: i % 3 === 0 ? 0xffffff : i % 3 === 1 ? 0xfff3b0 : colorHex,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.sparkQuadGeo, mat)
      mesh.position.copy(pos)
      this.group.add(mesh)

      const theta = Math.random() * Math.PI * 2
      const phi = (Math.random() - 0.32) * Math.PI * 0.85
      const spd = speed * (0.55 + Math.random() * 0.95)
      this.sparks.push({
        mesh,
        vx: Math.cos(theta) * Math.cos(phi) * spd,
        vy: Math.sin(phi) * spd + speed * 0.22,
        vz: Math.sin(theta) * Math.cos(phi) * spd,
        life: 0,
        maxLife: 0.22 + Math.random() * 0.28,
        gravity: 28,
        baseWidth: (0.22 + Math.random() * 0.24) * scale,
        lengthFactor: (1.35 + Math.random() * 1.4) * scale,
      })
    }
  }

  public triggerShieldBlockFlash() {
    this.shieldFlash = 1
  }

  /** 刀锋锐利空气震波细环（薄如刀刃、高速扩张消散，绝不遮挡怪兽画面） */
  public spawnImpactRing(pos: THREE.Vector3, colorHex: number, maxRadius = 6.5) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(colorHex) },
        uProgress: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uProgress;
        varying vec2 vUv;
        void main() {
          float r = length((vUv - 0.5) * 2.0);
          if (r > 1.0) discard;
          // 极细外缘刀锋亮线 + 柔和内衰减尾迹
          float edge = exp(-pow((r - 0.92) * 28.0, 2.0));
          float wake = smoothstep(0.62, 0.92, r) * (1.0 - smoothstep(0.92, 0.98, r)) * 0.35;
          float fade = pow(1.0 - clamp(uProgress, 0.0, 1.0), 1.65);
          vec3 col = mix(uColor, vec3(1.0), edge * 0.75);
          gl_FragColor = vec4(col, (edge + wake) * fade);
        }
      `,
    })
    const mesh = new THREE.Mesh(this.shockwaveGeo, mat)
    mesh.position.copy(pos)
    mesh.scale.setScalar(0.35)
    this.group.add(mesh)
    this.shockwaves.push({ mesh, life: 0, maxLife: 0.24, maxRadius })
  }

  /** 命中十字星芒爆闪（瞬间绽放并快速收敛） */
  public spawnHitFlash(pos: THREE.Vector3, colorHex: number, scale = 1) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.flareTex,
        color: colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        rotation: Math.random() * Math.PI,
      }),
    )
    sprite.position.copy(pos)
    sprite.scale.setScalar(1.2 * scale)
    this.group.add(sprite)
    this.flares.push({
      mesh: sprite,
      life: 0,
      maxLife: 0.18,
      peakScale: 5.4 * scale,
      spinSpeed: (Math.random() > 0.5 ? 1 : -1) * 5.5,
    })
  }

  public updateShield(
    active: boolean,
    heroX: number,
    heroZ: number,
    dt: number,
    elapsed: number,
    sideSign: 1 | -1 = 1,
  ) {
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3.4)
    this.shieldMesh.visible = active || this.shieldFlash > 0.04
    if (!this.shieldMesh.visible) return
    this.shieldMesh.position.set(heroX, 8.9, heroZ - 2.6 * sideSign)
    const pulse = 1 + Math.sin(elapsed * 12) * 0.025 + this.shieldFlash * 0.16
    this.shieldMesh.scale.setScalar(pulse)
    this.shieldMesh.material.uniforms.uTime!.value = elapsed
    this.shieldMesh.material.uniforms.uFlash!.value = this.shieldFlash
  }

  public updateChargePreview(
    beamCharge: number,
    beamPos: THREE.Vector3,
    discCharge: number,
    discPos: THREE.Vector3,
    elapsed: number,
  ) {
    if (beamCharge > 0.05 && !this.heroBeamActive) {
      this.chargeSprite.visible = true
      this.chargeSprite.position.copy(beamPos)
      this.chargeSprite.material.rotation = elapsed * 5.5
      const s = 1.6 + beamCharge * 4.2 + Math.sin(elapsed * 26) * 0.35
      this.chargeSprite.scale.set(s, s, 1)
    } else {
      this.chargeSprite.visible = false
    }

    if (discCharge > 0.08) {
      this.chargeDiscPreview.visible = true
      this.chargeDiscPreview.position.copy(discPos)
      this.chargeDiscPreview.scale.setScalar(0.35 + discCharge * 0.85)
      this.chargeDiscPreview.rotation.y += 0.32
    } else {
      this.chargeDiscPreview.visible = false
    }
  }

  public updateTypeCharge(
    charge: number,
    pos: THREE.Vector3,
    colorHex: number,
    elapsed: number,
  ) {
    if (charge > 0.03) {
      this.typeChargeSprite.visible = true
      this.typeChargeSprite.position.copy(pos)
      this.typeChargeSprite.material.color.setHex(colorHex)
      this.typeChargeSprite.material.rotation = -elapsed * 6.0
      const s = 2.0 + charge * 5.8 + Math.sin(elapsed * 22) * 0.4 * charge
      this.typeChargeSprite.scale.set(s, s, 1)
    } else {
      this.typeChargeSprite.visible = false
    }
  }

  public updateWarningRing(
    visible: boolean,
    heroX: number,
    heroZ: number,
    urgency: number,
    elapsed: number,
  ) {
    this.warningRing.visible = visible
    if (!visible) return
    this.warningRing.position.set(heroX, 0.28, heroZ - 3.6)
    this.warningRing.material.uniforms.uTime!.value = elapsed
    this.warningRing.material.uniforms.uUrgency!.value = urgency
  }

  private alignCylinder(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number) {
    const dir = to.clone().sub(from)
    const len = Math.max(0.01, dir.length())
    mesh.position.copy(from).addScaledVector(dir, 0.5)
    mesh.quaternion.setFromUnitVectors(this.upAxis, dir.normalize())
    mesh.scale.set(radius, len, radius)
  }

  public update(
    dt: number,
    elapsed: number,
    heroBeamSegment: [THREE.Vector3, THREE.Vector3],
    kaijuTarget: THREE.Vector3,
    kaijuEmit: THREE.Vector3,
    heroCenter: THREE.Vector3,
    cameraQuat?: THREE.Quaternion,
  ) {
    const heroOrigin = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], 0.58)
    const clashPoint = heroOrigin.clone().lerp(kaijuEmit, this.clashProgress)

    // 1. 英雄等离子必杀光线
    if (this.heroBeamActive) {
      this.heroBeamTime += dt
      const progress = this.heroBeamTime / this.heroBeamDuration
      if (progress >= 1 && !this.clashActive) {
        this.heroBeamActive = false
        this.heroBeamGroup.visible = false
      } else {
        const reveal = this.clashActive ? 1 : Math.min(1, this.heroBeamTime / 0.11)
        const fade =
          this.clashActive || progress <= 0.78 ? 1 : Math.max(0, (1 - progress) / 0.22)
        const targetEnd = this.clashActive ? clashPoint : kaijuTarget
        const end = heroOrigin.clone().lerp(targetEnd, reveal)
        const baseR = this.heroBeamSuper ? 1.15 : 0.78
        const pulse = 1 + Math.sin(elapsed * 44) * 0.1

        this.heroBeamInner.material.uniforms.uTime!.value = elapsed
        this.heroBeamInner.material.uniforms.uFade!.value = fade
        this.heroBeamOuter.material.uniforms.uTime!.value = elapsed
        this.heroBeamOuter.material.uniforms.uFade!.value = fade

        this.alignCylinder(this.heroBeamInner, heroOrigin, end, baseR * 0.42 * pulse)
        this.alignCylinder(this.heroBeamOuter, heroOrigin, end, baseR * 1.12 * pulse)

        this.heroBeamFilaments.forEach((f, idx) => {
          const t = (idx + 0.5) / this.heroBeamFilaments.length
          const startPt = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], t)
          const ang = elapsed * 18 + idx * 1.57
          const offset = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0).multiplyScalar(
            baseR * 0.48 * fade,
          )
          const farPt = end.clone().add(offset)
          this.alignCylinder(f, startPt, farPt, baseR * 0.08 * fade)
          f.material.opacity = 0.5 * fade
        })

        // 精巧十字发射星芒贴合前臂外侧，绝不遮挡手臂轮廓
        this.heroMuzzleSprite.position.copy(heroOrigin)
        this.heroMuzzleSprite.material.rotation = elapsed * 8
        const mScale = (baseR * 3.4 + Math.sin(elapsed * 32) * 0.4) * fade
        this.heroMuzzleSprite.scale.set(mScale, mScale, 1)

        this.heroImpactSprite.position.copy(end)
        this.heroImpactSprite.material.rotation = -elapsed * 10
        const iScale = (baseR * 5.2 + Math.cos(elapsed * 36) * 0.6) * fade
        this.heroImpactSprite.scale.set(iScale, iScale, 1)

        if (reveal > 0.85 && Math.random() < 0.65) {
          this.spawnBurst(
            end,
            this.heroBeamColorHex,
            2,
            24,
            this.heroBeamSuper ? 1.1 : 0.8,
          )
        }
      }
    }

    // 2. 怪兽暗黑破坏光线 & 双光线对波奇点
    if (this.kaijuBeamTime > 0 || this.clashActive) {
      if (!this.clashActive) {
        this.kaijuBeamTime += dt
      }
      const p = this.clashActive ? 0.3 : this.kaijuBeamTime / this.kaijuBeamDuration
      if (p >= 1 && !this.clashActive) {
        this.kaijuBeamTime = 0
        this.kaijuBeamGroup.visible = false
      } else {
        this.kaijuBeamGroup.visible = true
        const fade = !this.clashActive && p > 0.72 ? (1 - p) / 0.28 : 1
        const beamEnd = this.clashActive ? clashPoint : heroCenter
        this.kaijuBeamInner.material.uniforms.uTime!.value = elapsed
        this.kaijuBeamInner.material.uniforms.uFade!.value = fade
        this.kaijuBeamOuter.material.uniforms.uTime!.value = elapsed
        this.kaijuBeamOuter.material.uniforms.uFade!.value = fade
        this.alignCylinder(this.kaijuBeamInner, kaijuEmit, beamEnd, 0.42)
        this.alignCylinder(this.kaijuBeamOuter, kaijuEmit, beamEnd, 1.08)
      }
    }

    if (this.clashActive) {
      this.clashGroup.position.copy(clashPoint)
      const jitter = 1.35 + Math.sin(elapsed * 48) * 0.25
      this.clashCore.scale.setScalar(jitter)
      this.clashFlare.material.rotation = elapsed * 14
      this.clashFlare.scale.setScalar(jitter * 5.2)
      if (Math.random() < 0.8) {
        this.spawnBurst(clashPoint, Math.random() > 0.5 ? this.heroBeamColorHex : 0xd946ef, 2, 28, 1.0)
      }
    }

    // 3. 更新抛射物
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i]!
      proj.age += dt
      proj.pos.addScaledVector(proj.vel, dt)
      proj.mesh.position.copy(proj.pos)

      if (proj.kind === 'ultra-disc') {
        proj.mesh.rotation.y += dt * 30
      } else if (proj.kind === 'punch-wave' || proj.kind === 'kick-wave') {
        proj.mesh.scale.addScalar(dt * 3.4)
        if (proj.kind === 'kick-wave') proj.mesh.rotation.z += dt * 18
      } else if (proj.kind === 'kaiju-fireball') {
        proj.mesh.rotation.x += dt * 8
        proj.mesh.rotation.y += dt * 6
        if (Math.random() < 0.45) {
          this.spawnBurst(proj.pos, 0xff6b2b, 1, 8, 0.55)
        }
      }

      if (proj.hitTriggered || proj.age >= proj.maxAge) {
        this.removeProjectileAt(i)
      }
    }

    // 4. 更新电光拉伸火花条
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i]!
      p.life += dt
      if (p.life >= p.maxLife) {
        this.group.remove(p.mesh)
        ;(p.mesh.material as THREE.Material).dispose()
        this.sparks.splice(i, 1)
        continue
      }
      p.vy -= p.gravity * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(0.08, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt

      const speed = Math.hypot(p.vx, p.vy, p.vz)
      const ratio = 1 - p.life / p.maxLife
      if (speed > 0.05) {
        this.tmpDir.set(p.vx / speed, p.vy / speed, p.vz / speed)
        p.mesh.quaternion.setFromUnitVectors(this.upAxis, this.tmpDir)
      }
      const len = Math.max(p.baseWidth, p.baseWidth * p.lengthFactor * (0.4 + speed * 0.045) * ratio)
      p.mesh.scale.set(p.baseWidth * ratio, len, p.baseWidth * ratio)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, ratio * 1.35)
    }

    // 5. 更新刀锋震波细环（始终朝向相机以呈现完美冲击圆环）
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const r = this.shockwaves[i]!
      r.life += dt
      if (r.life >= r.maxLife) {
        this.group.remove(r.mesh)
        r.mesh.material.dispose()
        this.shockwaves.splice(i, 1)
        continue
      }
      const t = r.life / r.maxLife
      const ease = 1 - Math.pow(1 - t, 3)
      if (cameraQuat) r.mesh.quaternion.copy(cameraQuat)
      r.mesh.scale.setScalar(0.35 + ease * r.maxRadius)
      r.mesh.material.uniforms.uProgress!.value = t
    }

    // 6. 更新十字星芒爆点
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]!
      f.life += dt
      if (f.life >= f.maxLife) {
        this.group.remove(f.mesh)
        f.mesh.material.dispose()
        this.flares.splice(i, 1)
        continue
      }
      const t = f.life / f.maxLife
      const grow = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75
      f.mesh.scale.setScalar(Math.max(0.1, grow * f.peakScale))
      f.mesh.material.rotation += dt * f.spinSpeed
      f.mesh.material.opacity = Math.pow(1 - t, 1.5)
    }
  }

  public removeProjectileAt(index: number) {
    const proj = this.projectiles[index]
    if (!proj) return
    this.group.remove(proj.mesh)
    proj.mesh.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const m = node as THREE.Mesh
        m.geometry.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.dispose()
      } else if ((node as THREE.Sprite).isSprite) {
        ;(node as THREE.Sprite).material.dispose()
      }
    })
    this.projectiles.splice(index, 1)
  }

  public clearAllDynamic() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      this.removeProjectileAt(i)
    }
    for (const p of this.sparks) {
      this.group.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
    }
    this.sparks = []
    for (const r of this.shockwaves) {
      this.group.remove(r.mesh)
      r.mesh.material.dispose()
    }
    this.shockwaves = []
    for (const f of this.flares) {
      this.group.remove(f.mesh)
      f.mesh.material.dispose()
    }
    this.flares = []
    this.heroBeamActive = false
    this.heroBeamGroup.visible = false
    this.kaijuBeamTime = 0
    this.kaijuBeamGroup.visible = false
    this.kaijuChargeSprite.visible = false
    this.clashActive = false
    this.clashGroup.visible = false
    this.shieldMesh.visible = false
    this.chargeSprite.visible = false
    this.chargeDiscPreview.visible = false
    this.typeChargeSprite.visible = false
    this.warningRing.visible = false
  }

  public dispose() {
    this.clearAllDynamic()
    this.sparkQuadGeo.dispose()
    this.shockwaveGeo.dispose()
    this.flareTex.dispose()
    this.sparkTex.dispose()
    this.heroBeamInner.geometry.dispose()
    this.heroBeamInner.material.dispose()
    this.heroBeamOuter.material.dispose()
    for (const f of this.heroBeamFilaments) f.material.dispose()
    this.heroMuzzleSprite.material.dispose()
    this.heroImpactSprite.material.dispose()
    this.kaijuBeamInner.material.dispose()
    this.kaijuBeamOuter.material.dispose()
    this.kaijuChargeSprite.material.dispose()
    this.clashCore.geometry.dispose()
    ;(this.clashCore.material as THREE.Material).dispose()
    this.clashFlare.material.dispose()
    this.shieldMesh.geometry.dispose()
    this.shieldMesh.material.dispose()
    this.chargeSprite.material.dispose()
    this.typeChargeSprite.material.dispose()
    this.warningRing.geometry.dispose()
    this.warningRing.material.dispose()
  }
}
