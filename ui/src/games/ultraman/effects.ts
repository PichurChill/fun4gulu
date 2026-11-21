import * as THREE from 'three'
import type { HeroProfile } from './heroes'

interface Particle {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  gravity: number
  startScale: number
}

interface ImpactRing {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  maxRadius: number
}

interface HitFlash {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  startScale: number
}

interface Projectile {
  kind: 'punch-wave' | 'kick-wave' | 'ultra-disc' | 'kaiju-fireball'
  mesh: THREE.Object3D
  pos: THREE.Vector3
  vel: THREE.Vector3
  radius: number
  damage: number
  age: number
  maxAge: number
  fromHero: boolean
  hitTriggered: boolean
}

/**
 * 3D 特摄特效系统（哉佩利敖光线束、八分光轮、拳风冲击波、奥特护盾、怪兽火球与暗黑射线、粒子爆炸）
 */
export class BattleEffects {
  private readonly group = new THREE.Group()
  private particles: Particle[] = []
  private impactRings: ImpactRing[] = []
  private hitFlashes: HitFlash[] = []
  public projectiles: Projectile[] = []

  // 共享几何，降低 GC 抖动
  private readonly sparkGeo = new THREE.SphereGeometry(0.45, 6, 6)

  // 哉佩利敖光线组（核心光柱 + 外层辉光 + 6 根螺旋能量丝 + 发射光球 + 命中爆点）
  private readonly heroBeamGroup = new THREE.Group()
  private readonly heroBeamCore: THREE.Mesh
  private readonly heroBeamOuter: THREE.Mesh
  private readonly heroBeamFilaments: THREE.Mesh[] = []
  private readonly heroBeamOriginOrb: THREE.Mesh
  private readonly heroBeamImpactOrb: THREE.Mesh
  private heroBeamActive = false
  private heroBeamSuper = false
  private heroBeamColorHex = 0x38d9ff
  private heroBeamTime = 0
  private heroBeamDuration = 1.4

  // 怪兽暗黑光线
  private readonly kaijuBeamGroup = new THREE.Group()
  private readonly kaijuBeamCore: THREE.Mesh
  private readonly kaijuBeamOuter: THREE.Mesh
  private kaijuBeamTime = 0
  private kaijuBeamDuration = 0.75

  // 迪迦奥特屏障护盾
  private readonly shieldMesh: THREE.Mesh
  private shieldFlash = 0

  // 蓄力手部光球（光线蓄力 & 光轮蓄力预览）
  private readonly chargeOrb: THREE.Mesh
  private readonly chargeDiscPreview: THREE.Group

  // 怪兽攻击地面危险预警圈
  private readonly warningRing: THREE.Mesh

  private readonly upAxis = new THREE.Vector3(0, 1, 0)

  // 当前英雄主题配色（迪迦青蓝 / 赛罗冰蓝等，由 engine 切换英雄时注入）
  private themeBeamColor = 0x38d9ff
  private themeBeamSuperColor = 0xfacc15
  private themeDiscColor = 0x38e8ff
  private themeBurstColor = 0x67e8f9

  public setHeroTheme(profile: HeroProfile) {
    this.themeBeamColor = profile.beamColor
    this.themeBeamSuperColor = profile.beamSuperColor
    this.themeDiscColor = profile.discColor
    this.themeBurstColor = profile.burstColor
    ;(this.chargeOrb.material as THREE.MeshBasicMaterial).color.setHex(profile.accentColor)
    this.chargeDiscPreview.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mat = (node as THREE.Mesh).material
        if (mat instanceof THREE.MeshBasicMaterial) mat.color.setHex(profile.discColor)
      }
    })
  }

  constructor(scene: THREE.Scene) {
    this.group.name = 'BattleEffects'
    scene.add(this.group)

    // 1. 哉佩利敖光线
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true)
    this.heroBeamCore = new THREE.Mesh(
      cylGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroBeamOuter = new THREE.Mesh(
      cylGeo,
      new THREE.MeshBasicMaterial({
        color: 0x38d9ff,
        transparent: true,
        opacity: 0.58,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.heroBeamGroup.add(this.heroBeamCore, this.heroBeamOuter)

    for (let i = 0; i < 6; i++) {
      const f = new THREE.Mesh(
        cylGeo,
        new THREE.MeshBasicMaterial({
          color: i % 2 === 0 ? 0xa5f3fc : 0xfef08a,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      this.heroBeamGroup.add(f)
      this.heroBeamFilaments.push(f)
    }

    const orbGeo = new THREE.SphereGeometry(1, 14, 12)
    this.heroBeamOriginOrb = new THREE.Mesh(
      orbGeo,
      new THREE.MeshBasicMaterial({
        color: 0xe0f7ff,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroBeamImpactOrb = new THREE.Mesh(
      orbGeo,
      new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.heroBeamGroup.add(this.heroBeamOriginOrb, this.heroBeamImpactOrb)
    this.heroBeamGroup.visible = false
    this.group.add(this.heroBeamGroup)

    // 2. 怪兽暗黑破坏光线
    this.kaijuBeamCore = new THREE.Mesh(
      cylGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffd1f7,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.kaijuBeamOuter = new THREE.Mesh(
      cylGeo,
      new THREE.MeshBasicMaterial({
        color: 0xa855f7,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.kaijuBeamGroup.add(this.kaijuBeamCore, this.kaijuBeamOuter)
    this.kaijuBeamGroup.visible = false
    this.group.add(this.kaijuBeamGroup)

    // 3. 迪迦奥特屏障护盾（六边形能量穹盾）
    const shieldGeo = new THREE.CircleGeometry(4.6, 6)
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat)
    // 添加护盾边框线
    const shieldEdge = new THREE.LineLoop(
      new THREE.EdgesGeometry(shieldGeo),
      new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.9 }),
    )
    this.shieldMesh.add(shieldEdge)
    this.shieldMesh.visible = false
    this.group.add(this.shieldMesh)

    // 4. 蓄力光球与八分光轮预览
    this.chargeOrb = new THREE.Mesh(
      orbGeo,
      new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.chargeOrb.visible = false
    this.group.add(this.chargeOrb)

    this.chargeDiscPreview = this.createSawDiscMesh(1.8)
    this.chargeDiscPreview.visible = false
    this.group.add(this.chargeDiscPreview)

    // 5. 怪兽攻击地面危险预警光环
    const ringGeo = new THREE.RingGeometry(4.6, 6.2, 32)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3b30,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    this.warningRing = new THREE.Mesh(ringGeo, ringMat)
    this.warningRing.rotation.x = -Math.PI / 2
    this.warningRing.position.set(0, 0.12, 20)
    this.warningRing.visible = false
    this.group.add(this.warningRing)
  }

  /** 构建经典锯齿状发光八分光轮网格 */
  private createSawDiscMesh(radius: number): THREE.Group {
    const g = new THREE.Group()
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.35, radius, 24),
      new THREE.MeshBasicMaterial({
        color: this.themeDiscColor,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    ring.rotation.x = -Math.PI / 2
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.45, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    core.rotation.x = -Math.PI / 2
    g.add(ring, core)

    // 10 颗外缘锯齿光刃
    const toothGeo = new THREE.ConeGeometry(radius * 0.22, radius * 0.55, 4)
    const toothMat = new THREE.MeshBasicMaterial({
      color: 0xe0f7ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const tooth = new THREE.Mesh(toothGeo, toothMat)
      tooth.position.set(Math.cos(a) * radius * 1.05, 0, Math.sin(a) * radius * 1.05)
      tooth.rotation.z = -Math.PI / 2
      tooth.rotation.y = -a
      g.add(tooth)
    }
    return g
  }

  public startHeroBeam(isSuper: boolean) {
    this.heroBeamActive = true
    this.heroBeamSuper = isSuper
    this.heroBeamTime = 0
    this.heroBeamDuration = isSuper ? 1.75 : 1.25
    this.heroBeamGroup.visible = true
    const outerMat = this.heroBeamOuter.material as THREE.MeshBasicMaterial
    const impactMat = this.heroBeamImpactOrb.material as THREE.MeshBasicMaterial
    outerMat.color.setHex(isSuper ? this.themeBeamSuperColor : this.themeBeamColor)
    impactMat.color.setHex(isSuper ? 0xfef08a : this.themeBeamColor)
    this.heroBeamColorHex = isSuper ? this.themeBeamSuperColor : this.themeBeamColor
  }

  public isHeroBeamActive(): boolean {
    return this.heroBeamActive
  }

  public startKaijuBeam(accentColor: number) {
    this.kaijuBeamTime = 0.001
    this.kaijuBeamDuration = 0.72
    this.kaijuBeamGroup.visible = true
    ;(this.kaijuBeamOuter.material as THREE.MeshBasicMaterial).color.setHex(accentColor)
  }

  /** 发射出拳能量冲击波 */
  public spawnPunchWave(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const wave = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.24, 8, 18),
      new THREE.MeshBasicMaterial({
        color: this.themeBurstColor,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    wave.position.copy(origin)
    wave.lookAt(target)
    this.group.add(wave)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(82)
    this.projectiles.push({
      kind: 'punch-wave',
      mesh: wave,
      pos: origin.clone(),
      vel,
      radius: 2.8,
      damage,
      age: 0,
      maxAge: 0.7,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 发射奥特飞踢金红旋风冲击波 */
  public spawnKickWave(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const grp = new THREE.Group()
    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(1.65, 0.3, 8, 20),
      new THREE.MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.94,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.22, 8, 18),
      new THREE.MeshBasicMaterial({
        color: 0xfef08a,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    grp.add(outer, inner)
    grp.position.copy(origin)
    grp.lookAt(target)
    this.group.add(grp)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(78)
    this.projectiles.push({
      kind: 'kick-wave',
      mesh: grp,
      pos: origin.clone(),
      vel,
      radius: 3.2,
      damage,
      age: 0,
      maxAge: 0.75,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 发射八分光轮 */
  public spawnUltraDisc(origin: THREE.Vector3, target: THREE.Vector3, damage: number) {
    const disc = this.createSawDiscMesh(2.5)
    disc.position.copy(origin)
    this.group.add(disc)

    const vel = target.clone().sub(origin).normalize().multiplyScalar(62)
    this.projectiles.push({
      kind: 'ultra-disc',
      mesh: disc,
      pos: origin.clone(),
      vel,
      radius: 3.4,
      damage,
      age: 0,
      maxAge: 1.2,
      fromHero: true,
      hitTriggered: false,
    })
  }

  /** 发射怪兽火球 / 破坏光球 */
  public spawnKaijuFireball(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    colorHex: number,
    damage: number,
  ) {
    const fireball = new THREE.Group()
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(1.45, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff7ed }),
    )
    const outer = new THREE.Mesh(
      new THREE.SphereGeometry(2.15, 12, 10),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    fireball.add(inner, outer)
    fireball.position.copy(origin)
    this.group.add(fireball)

    // 速度适中（34 单位/秒），给小朋友充裕时间看清并用护盾防御或左右闪避！
    const vel = target.clone().sub(origin).normalize().multiplyScalar(34)
    this.projectiles.push({
      kind: 'kaiju-fireball',
      mesh: fireball,
      pos: origin.clone(),
      vel,
      radius: 2.6,
      damage,
      age: 0,
      maxAge: 2.2,
      fromHero: false,
      hitTriggered: false,
    })
  }

  /** 生成打击火花或大爆炸粒子 */
  public spawnBurst(
    pos: THREE.Vector3,
    colorHex: number,
    count = 16,
    speed = 18,
    scale = 1.0,
  ) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xffffff : colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.sparkGeo, mat)
      mesh.position.copy(pos)
      const s = (0.6 + Math.random() * 1.1) * scale
      mesh.scale.setScalar(s)
      this.group.add(mesh)

      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI - Math.PI * 0.35
      const spd = speed * (0.45 + Math.random() * 0.85)
      this.particles.push({
        mesh,
        vx: Math.cos(theta) * Math.cos(phi) * spd,
        vy: Math.sin(phi) * spd + speed * 0.25,
        vz: Math.sin(theta) * Math.cos(phi) * spd,
        life: 0,
        maxLife: 0.32 + Math.random() * 0.38,
        gravity: 22,
        startScale: s,
      })
    }
  }

  public triggerShieldBlockFlash() {
    this.shieldFlash = 1
  }

  /** 命中冲击环：从命中点快速扩张的能量环（朝向镜头的 XY 平面），强化打击的力量反馈 */
  public spawnImpactRing(pos: THREE.Vector3, colorHex: number, maxRadius = 7) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    ring.position.copy(pos)
    ring.scale.setScalar(0.4)
    this.group.add(ring)
    this.impactRings.push({ mesh: ring, life: 0, maxLife: 0.3, maxRadius })
  }

  /** 命中白热爆闪：命中瞬间短暂胀大的炽白光球，赋予打击沉甸甸的份量感 */
  public spawnHitFlash(pos: THREE.Vector3, colorHex: number, scale = 1) {
    const flash = new THREE.Mesh(
      this.sparkGeo,
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    flash.position.copy(pos)
    flash.scale.setScalar(0.5 * scale)
    this.group.add(flash)
    this.hitFlashes.push({ mesh: flash, life: 0, maxLife: 0.16, startScale: scale })
  }

  public updateShield(active: boolean, heroX: number, heroZ: number, dt: number, elapsed: number) {
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3.2)
    this.shieldMesh.visible = active || this.shieldFlash > 0.05
    if (!this.shieldMesh.visible) return
    this.shieldMesh.position.set(heroX, 8.8, heroZ - 3.0)
    const pulse = 1 + Math.sin(elapsed * 12) * 0.04 + this.shieldFlash * 0.22
    this.shieldMesh.scale.setScalar(pulse)
    const mat = this.shieldMesh.material as THREE.MeshBasicMaterial
    mat.color.setHex(this.shieldFlash > 0.2 ? 0xfef08a : 0x38bdf8)
    mat.opacity = active ? 0.32 + this.shieldFlash * 0.45 : this.shieldFlash * 0.5
  }

  public updateChargePreview(
    beamCharge: number,
    beamPos: THREE.Vector3,
    discCharge: number,
    discPos: THREE.Vector3,
    elapsed: number,
  ) {
    if (beamCharge > 0.05 && !this.heroBeamActive) {
      this.chargeOrb.visible = true
      this.chargeOrb.position.copy(beamPos)
      const s = 0.65 + beamCharge * 1.9 + Math.sin(elapsed * 26) * 0.16
      this.chargeOrb.scale.setScalar(s)
    } else {
      this.chargeOrb.visible = false
    }

    if (discCharge > 0.08) {
      this.chargeDiscPreview.visible = true
      this.chargeDiscPreview.position.copy(discPos)
      this.chargeDiscPreview.scale.setScalar(0.35 + discCharge * 0.85)
      this.chargeDiscPreview.rotation.y += 0.28
    } else {
      this.chargeDiscPreview.visible = false
    }
  }

  public updateWarningRing(visible: boolean, heroX: number, urgency: number, elapsed: number) {
    this.warningRing.visible = visible
    if (!visible) return
    this.warningRing.position.set(heroX, 0.15, 20)
    const mat = this.warningRing.material as THREE.MeshBasicMaterial
    mat.opacity = 0.35 + 0.45 * Math.abs(Math.sin(elapsed * 14))
    const scale = 1.25 - urgency * 0.45
    this.warningRing.scale.setScalar(scale)
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
  ) {
    // 1. 更新哉佩利敖光线
    if (this.heroBeamActive) {
      this.heroBeamTime += dt
      const progress = this.heroBeamTime / this.heroBeamDuration
      if (progress >= 1) {
        this.heroBeamActive = false
        this.heroBeamGroup.visible = false
      } else {
        const reveal = Math.min(1, this.heroBeamTime / 0.14)
        const fade = progress > 0.78 ? Math.max(0, (1 - progress) / 0.22) : 1
        const origin = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], 0.58)
        const end = origin.clone().lerp(kaijuTarget, reveal)
        const baseR = this.heroBeamSuper ? 1.55 : 0.95
        const pulse = 1 + Math.sin(elapsed * 42) * 0.14

        this.alignCylinder(this.heroBeamCore, origin, end, baseR * 0.48 * fade * pulse)
        this.alignCylinder(this.heroBeamOuter, origin, end, baseR * 1.15 * fade * pulse)

        this.heroBeamFilaments.forEach((f, idx) => {
          const t = (idx + 0.5) / this.heroBeamFilaments.length
          const startPt = heroBeamSegment[0].clone().lerp(heroBeamSegment[1], t)
          const ang = elapsed * 16 + idx * 1.05
          const offset = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0).multiplyScalar(
            baseR * 0.55 * fade,
          )
          const farPt = end.clone().add(offset)
          this.alignCylinder(f, startPt, farPt, baseR * 0.12 * fade)
        })

        this.heroBeamOriginOrb.position.copy(origin)
        this.heroBeamOriginOrb.scale.setScalar((baseR * 0.9 + Math.sin(elapsed * 32) * 0.15) * fade)
        this.heroBeamImpactOrb.position.copy(end)
        this.heroBeamImpactOrb.scale.setScalar((baseR * 1.35 + Math.cos(elapsed * 36) * 0.25) * fade)

        if (reveal > 0.85 && Math.random() < 0.75) {
          this.spawnBurst(
            end,
            this.heroBeamColorHex,
            3,
            24,
            this.heroBeamSuper ? 1.2 : 0.85,
          )
        }
      }
    }

    // 2. 更新怪兽暗黑破坏光线
    if (this.kaijuBeamTime > 0) {
      this.kaijuBeamTime += dt
      const p = this.kaijuBeamTime / this.kaijuBeamDuration
      if (p >= 1) {
        this.kaijuBeamTime = 0
        this.kaijuBeamGroup.visible = false
      } else {
        const fade = p > 0.7 ? (1 - p) / 0.3 : 1
        this.alignCylinder(this.kaijuBeamCore, kaijuEmit, heroCenter, 0.55 * fade)
        this.alignCylinder(this.kaijuBeamOuter, kaijuEmit, heroCenter, 1.35 * fade)
      }
    }

    // 3. 更新抛射物（拳风、八分光轮、怪兽火球）
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i]!
      proj.age += dt
      proj.pos.addScaledVector(proj.vel, dt)
      proj.mesh.position.copy(proj.pos)

      if (proj.kind === 'ultra-disc') {
        proj.mesh.rotation.y += dt * 26
      } else if (proj.kind === 'punch-wave' || proj.kind === 'kick-wave') {
        proj.mesh.scale.addScalar(dt * 3.8)
        if (proj.kind === 'kick-wave') proj.mesh.rotation.z += dt * 16
      } else if (proj.kind === 'kaiju-fireball') {
        proj.mesh.rotation.x += dt * 8
        proj.mesh.rotation.y += dt * 6
        if (Math.random() < 0.45) {
          this.spawnBurst(proj.pos, 0xff6b2b, 1, 6, 0.6)
        }
      }

      if (proj.hitTriggered || proj.age >= proj.maxAge) {
        this.removeProjectileAt(i)
      }
    }

    // 4. 更新粒子系统
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!
      p.life += dt
      if (p.life >= p.maxLife) {
        this.group.remove(p.mesh)
        ;(p.mesh.material as THREE.Material).dispose()
        this.particles.splice(i, 1)
        continue
      }
      p.vy -= p.gravity * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(0.1, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt
      const ratio = 1 - p.life / p.maxLife
      p.mesh.scale.setScalar(p.startScale * ratio)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = ratio
    }

    // 5. 更新命中冲击环（先急速扩张后减速淡出）
    for (let i = this.impactRings.length - 1; i >= 0; i--) {
      const r = this.impactRings[i]!
      r.life += dt
      if (r.life >= r.maxLife) {
        this.group.remove(r.mesh)
        r.mesh.geometry.dispose()
        ;(r.mesh.material as THREE.Material).dispose()
        this.impactRings.splice(i, 1)
        continue
      }
      const t = r.life / r.maxLife
      const ease = 1 - Math.pow(1 - t, 3)
      r.mesh.scale.setScalar(0.4 + ease * r.maxRadius)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.95
    }

    // 6. 更新命中白热爆闪（瞬间胀大后急速熄灭）
    for (let i = this.hitFlashes.length - 1; i >= 0; i--) {
      const f = this.hitFlashes[i]!
      f.life += dt
      if (f.life >= f.maxLife) {
        this.group.remove(f.mesh)
        ;(f.mesh.material as THREE.Material).dispose()
        this.hitFlashes.splice(i, 1)
        continue
      }
      const t = f.life / f.maxLife
      const grow = t < 0.3 ? t / 0.3 : 1
      f.mesh.scale.setScalar((0.5 + grow * 2.6) * f.startScale)
      ;(f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - t, 2)
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
      }
    })
    this.projectiles.splice(index, 1)
  }

  public clearAllDynamic() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      this.removeProjectileAt(i)
    }
    for (const p of this.particles) {
      this.group.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
    }
    this.particles = []
    for (const r of this.impactRings) {
      this.group.remove(r.mesh)
      r.mesh.geometry.dispose()
      ;(r.mesh.material as THREE.Material).dispose()
    }
    this.impactRings = []
    for (const f of this.hitFlashes) {
      this.group.remove(f.mesh)
      ;(f.mesh.material as THREE.Material).dispose()
    }
    this.hitFlashes = []
    this.heroBeamActive = false
    this.heroBeamGroup.visible = false
    this.kaijuBeamTime = 0
    this.kaijuBeamGroup.visible = false
    this.shieldMesh.visible = false
    this.chargeOrb.visible = false
    this.chargeDiscPreview.visible = false
    this.warningRing.visible = false
  }
}
