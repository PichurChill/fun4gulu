"""
Blender 5.2 无头脚本：高保真影视皮套级重制迪迦奥特曼 (tiga.glb)
- 保留原厂 37,200 面高模与 52 根骨骼（含双锁骨与 30 根 3 节指骨）及全部精确蒙皮权重
- 清理废节点与原厂错位零件（Icosphere / 掉落的旧眼与旧计时器）
- 按 1996 权藤版皮套比例微雕头雕脸型、头冠锐度、黄金倒三角身材与胸甲双金条实体厚度
- 基于真实 3D 几何曲率烘焙头盔/胸甲精密雕塑立体 AO（顶点色）
- 原生高精雕刻并贴面蒙皮绑定：双层菱杏蜂窝复眼、额头银框菱形水晶、胸口标志性尖菱盾牌彩色计时器
- 挂载 2K 影视特摄级全通道 PBR 材质（深皇室紫 / 浓正红 / 冷钛银 / 24K 香槟金 + 拼缝法线 + 潜水料微粒 + ORM）
"""
import os
import math
import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
WORK_DIR = os.environ.get("ULTRAMAN_ART_WORK_DIR", os.path.join(BASE_DIR, "work"))
ORIG_GLB = os.path.join(WORK_DIR, "backup_orig_models/tiga.glb")
TEX_DIR = os.path.join(WORK_DIR, "pbr_textures")
OUT_GLB = os.path.join(REPO_ROOT, "ui/public/models/ultraman/tiga.glb")


def load_image(name: str, colorspace: str = "sRGB"):
    path = os.path.join(TEX_DIR, name)
    img = bpy.data.images.load(path, check_existing=True)
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def set_bsdf_input(bsdf, name: str, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def sculpt_tiga_body_proportions(body_obj: bpy.types.Object):
    """
    不增删顶点（100% 保护 52 骨蒙皮权重），按 1996 权藤俊辅版真实特摄皮套比例做温和精确微雕：
    1. 头雕双颊与下颌略微收紧俊朗（去圆脸），头冠中脊微微提拔更锐利
    2. 胸甲双金条沿局部顶点法线立体外推，赋予实体浮雕装甲厚度
    3. 三角肌肩线微扩 + 腰腹微收，凸显奥特曼经典倒三角英雄比例
    """
    mesh = body_obj.data
    mw = body_obj.matrix_world
    mw_inv = mw.inverted()
    mat_names = [s.material.name if s.material else "" for s in body_obj.material_slots]
    gold_slot = next((i for i, n in enumerate(mat_names) if "gold" in n.lower()), -1)

    gold_verts = set()
    if gold_slot >= 0:
        for poly in mesh.polygons:
            if poly.material_index == gold_slot:
                gold_verts.update(poly.vertices)

    # 先计算当前世界空间顶点法线（用于金条安全外推）
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    rot_m = mw.to_3x3()

    for v in bm.verts:
        wpos = mw @ v.co
        x, y, z = wpos.x, wpos.y, wpos.z

        # 1. 头雕比例精修 (z > 2.68)：俊朗面颊收窄 + 头冠中脊提拔
        if z > 2.68:
            # 双颊与下颌区 (2.70 < z < 2.95, 脸部前侧 y < 0.04, 避开耳廓外缘 |x| > 0.165)
            if 2.70 < z < 2.96 and y < 0.05:
                cheek_z = math.exp(-((z - 2.83) / 0.085) ** 2)
                ear_guard = max(0.0, 1.0 - max(0.0, (abs(x) - 0.145) / 0.045))
                front_w = max(0.0, min(1.0, (0.04 - y) / 0.14))
                x *= 1.0 - 0.048 * cheek_z * ear_guard * front_w
                # 下巴前沿微微挺拔微收
                if z < 2.82 and y < -0.05:
                    chin_w = math.exp(-((z - 2.76) / 0.045) ** 2) * math.exp(-(x / 0.075) ** 2)
                    y -= 0.0045 * chin_w
            # 头冠中脊微提锐利感 (z > 3.03, |x| < 0.045)
            if z > 3.03 and abs(x) < 0.055:
                crest_x = math.exp(-(x / 0.026) ** 2)
                crest_z = max(0.0, min(1.0, (z - 3.03) / 0.14))
                z += 0.013 * crest_x * crest_z

        # 2. 黄金倒三角身材精修：肩部三角肌饱满 + 腰腹收紧
        if 2.40 < z < 2.66 and abs(x) > 0.18:
            shoulder_w = math.exp(-((z - 2.53) / 0.085) ** 2) * min(1.0, (abs(x) - 0.18) / 0.12)
            x *= 1.0 + 0.032 * shoulder_w
            z += 0.005 * shoulder_w
        elif 1.82 < z < 2.24 and abs(x) < 0.30:
            waist_w = math.exp(-((z - 2.02) / 0.13) ** 2)
            x *= 1.0 - 0.034 * waist_w
            y *= 1.0 - 0.022 * waist_w

        # 3. 胸甲双金护甲条实体浮雕厚度增强（仅外推前侧与肩侧金条，背侧微推）
        if v.index in gold_verts:
            wnorm = (rot_m @ v.normal).normalized()
            push = 0.0048 if y < 0.02 else 0.0032
            x += wnorm.x * push
            y += wnorm.y * push
            z += wnorm.z * push

        v.co = mw_inv @ Vector((x, y, z))

    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    bpy.context.view_layer.update()


def bake_geometric_cavity_ao(body_obj: bpy.types.Object):
    """
    基于真实 3D 网格拓扑曲率/凹陷度计算头雕与银金装甲的雕塑级 Cavity AO（写入顶点色 Col_AO）：
    让眉骨、眼窝、鼻梁、双唇线、耳廓沟槽、胸甲阶梯折线自带电影级真实光影层次！
    """
    mesh = body_obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.normal_update()

    # 两阶邻域平滑曲率凹度（凹槽 < 0 压暗，凸棱 > 0 微提亮）
    raw_ao = [1.0] * len(bm.verts)
    for i, v in enumerate(bm.verts):
        if not v.link_edges:
            continue
        avg_pos = Vector((0.0, 0.0, 0.0))
        cnt = 0
        for e in v.link_edges:
            ov = e.other_vert(v)
            avg_pos += ov.co
            cnt += 1
        avg_pos /= max(1, cnt)
        # (v.co - avg_pos) · v.normal：凸处为正，凹槽为负
        delta = v.co - avg_pos
        avg_edge = sum(e.calc_length() for e in v.link_edges) / max(1, cnt)
        curvature = delta.dot(v.normal) / max(avg_edge, 1e-5)
        # 柔和雕塑阴影：凹槽温和压暗至 0.82（彻底杜绝嘴角下巴发黑竖杠），凸棱微提至 1.03
        ao_val = max(0.82, min(1.03, 0.97 + curvature * 0.24))
        raw_ao[i] = ao_val

    # 1 次拓扑平滑消除细碎锯齿
    smooth_ao = raw_ao[:]
    for i, v in enumerate(bm.verts):
        if not v.link_edges:
            continue
        acc = raw_ao[i] * 2.0
        w = 2.0
        for e in v.link_edges:
            acc += raw_ao[e.other_vert(v).index]
            w += 1.0
        smooth_ao[i] = acc / w

    # 写入顶点色属性 Col_AO（兼容 glTF 2.0 COLOR_0 与 Blender Attribute 节点）
    color_layer = bm.loops.layers.color.get("Col_AO")
    if color_layer is None:
        color_layer = bm.loops.layers.color.new("Col_AO")
    for face in bm.faces:
        for loop in face.loops:
            a = smooth_ao[loop.vert.index]
            loop[color_layer] = (a, a, a, 1.0)

    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def generate_box_uv_for_slots(body_obj: bpy.types.Object, target_slots: set[int], scale: float = 3.2):
    """为原厂无 UV 或重迭 UV 的银甲/金甲材质槽生成干净均匀的盒式投影 UV，便于贴合金属微粒法线"""
    mesh = body_obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_layer = mesh.uv_layers.active.data
    mw = body_obj.matrix_world
    for poly in mesh.polygons:
        if poly.material_index not in target_slots:
            continue
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            p = mw @ mesh.vertices[vi].co
            if az >= ax and az >= ay:
                uv_layer[li].uv = (p.x * scale, p.y * scale)
            elif ax >= ay:
                uv_layer[li].uv = (p.y * scale, p.z * scale)
            else:
                uv_layer[li].uv = (p.x * scale, p.z * scale)


def bind_object_to_bone(obj: bpy.types.Object, arm_obj: bpy.types.Object, bone_name: str):
    """将精雕网格以 100% 权重蒙皮绑定至指定骨骼，确保随头/随胸精准同步运动且导出为标准 glTF SkinnedMesh"""
    obj.parent = arm_obj
    obj.matrix_parent_inverse = arm_obj.matrix_world.inverted()
    vg = obj.vertex_groups.new(name=bone_name)
    all_verts = list(range(len(obj.data.vertices)))
    vg.add(all_verts, 1.0, "REPLACE")
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj


def project_onto_body(bvh: BVHTree, body_mw: Matrix, body_mw_inv: Matrix, x: float, z: float, y_start: float = -0.60):
    """从正前方 (-Y) 向 +Y 射线投射精确命中 TigaBody 表面，返回 (世界坐标, 世界法线)"""
    o_local = body_mw_inv @ Vector((x, y_start, z))
    d_local = (body_mw_inv.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized()
    loc, norm, idx, dist = bvh.ray_cast(o_local, d_local, 1.2)
    if loc is None:
        return None, None
    w_loc = body_mw @ loc
    w_norm = (body_mw.to_3x3() @ norm).normalized()
    if w_norm.y > 0:
        w_norm = -w_norm
    return w_loc, w_norm


def create_tiga_sculpted_eyes(body_obj: bpy.types.Object, arm_obj: bpy.types.Object, bvh: BVHTree, mat_eye, mat_rim):
    """
    原厂眼窝高精度贴面雕刻迪迦双目（外高内低锐利菱杏眼型 + 纤细深烟灰机械眼眶 + 光滑凸镜六角蜂窝晶格）：
    - 精准落于原厂双耳中段平齐、眉心水晶下尖斜下方的眼窝 (Z=2.948)
    - +2.8° 英武外上挑角，完全贴合微雕后的裸头雕真实曲面，零缝隙、零穿模、零歪斜
    """
    mw = body_obj.matrix_world
    mw_inv = mw.inverted()

    def build_eye_mesh(name: str, scale_xy: float, lift_edge: float, lift_center: float, mat, u_res=28, v_res=18):
        bm = bmesh.new()
        uv_layer = bm.loops.layers.uv.new("UVMap")

        for side in (-1, 1):  # -1=右侧(-X), +1=左侧(+X)（Blender -Y 朝前时，面向观众左侧为 -X、右侧为 +X）
            # 基准眼心与 1996 权藤版经典菱杏轮廓参数（优雅外上挑 +5.8°，眼神更英武立体）
            cx = side * 0.0688
            cz = 2.9485
            rx = 0.0505 * scale_xy
            rz = 0.0268 * scale_xy
            tilt = math.radians(5.8) * side  # 外眼角上挑
            cos_t = math.cos(tilt)
            sin_t = math.sin(tilt)

            # 构建极坐标光滑同心网格（中心 1 点 + rings 圈，外边缘精准勾勒经典杏眼尖角）
            rings = 10
            segs = 32
            ring_verts = []

            def sample_eye_point(r_norm: float, theta: float):
                ct = math.cos(theta)
                st = math.sin(theta)
                outer_flag = ct * side  # >0 外眼角, <0 内眼角
                # 内外眼角略微收尖，中段饱满舒展
                y_squeeze = 1.0 - 0.22 * (ct * ct)
                upper_boost = 1.15 if st > 0 else 0.88
                inner_dip = -0.0038 * max(0.0, -outer_flag) * r_norm
                lx = ct * rx * r_norm
                lz = st * rz * y_squeeze * upper_boost * r_norm + inner_dip
                px = cx + (lx * cos_t - lz * sin_t)
                pz = cz + (lx * sin_t + lz * cos_t)

                w_loc, w_norm = project_onto_body(bvh, mw, mw_inv, px, pz)
                if w_loc is None:
                    w_loc = Vector((px, -0.175, pz))
                    w_norm = Vector((side * 0.22, -0.96, 0.05)).normalized()

                dome = math.sqrt(max(0.0, 1.0 - r_norm * r_norm))
                offset = lift_edge + (lift_center - lift_edge) * (dome ** 0.85)
                final_pos = w_loc + w_norm * offset
                # 等比无拉伸平面投影 UV（保持六角光学蜂窝晶格 1:1 完美正六边形！）
                uv = (0.5 + (lx / (rx * 2.15)), 0.5 + (lz / (rx * 2.15)))
                return final_pos, uv

            c_pos, c_uv = sample_eye_point(0.0, 0.0)
            v_center = bm.verts.new(c_pos)
            ring_uvs = []
            for ri in range(1, rings + 1):
                rn = ri / rings
                r_vs = []
                r_us = []
                for si in range(segs):
                    th = (2.0 * math.pi * si) / segs
                    pos, uv = sample_eye_point(rn, th)
                    r_vs.append(bm.verts.new(pos))
                    r_us.append(uv)
                ring_verts.append(r_vs)
                ring_uvs.append(r_us)

            # 中心三角扇
            for si in range(segs):
                sn = (si + 1) % segs
                f = bm.faces.new((v_center, ring_verts[0][si], ring_verts[0][sn]))
                f.smooth = True
                f.loops[0][uv_layer].uv = c_uv
                f.loops[1][uv_layer].uv = ring_uvs[0][si]
                f.loops[2][uv_layer].uv = ring_uvs[0][sn]

            # 外圈四边形带
            for ri in range(rings - 1):
                for si in range(segs):
                    sn = (si + 1) % segs
                    v00 = ring_verts[ri][si]
                    v01 = ring_verts[ri][sn]
                    v11 = ring_verts[ri + 1][sn]
                    v10 = ring_verts[ri + 1][si]
                    f = bm.faces.new((v00, v10, v11, v01))
                    f.smooth = True
                    f.loops[0][uv_layer].uv = ring_uvs[ri][si]
                    f.loops[1][uv_layer].uv = ring_uvs[ri + 1][si]
                    f.loops[2][uv_layer].uv = ring_uvs[ri + 1][sn]
                    f.loops[3][uv_layer].uv = ring_uvs[ri][sn]

            # 为最外边缘添加向内贴入头雕的裙边（深度 -0.005m），任何侧角看都 100% 严丝合缝无漏缝！
            outer_ring = ring_verts[-1]
            skirt_verts = []
            for si in range(segs):
                th = (2.0 * math.pi * si) / segs
                p_out = outer_ring[si].co
                w_loc, w_norm = project_onto_body(bvh, mw, mw_inv, p_out.x, p_out.z)
                if w_loc is not None and w_norm is not None:
                    p_in = w_loc - w_norm * 0.0045
                else:
                    p_in = p_out + Vector((0, 0.006, 0))
                skirt_verts.append(bm.verts.new(p_in))
            for si in range(segs):
                sn = (si + 1) % segs
                f = bm.faces.new((outer_ring[si], skirt_verts[si], skirt_verts[sn], outer_ring[sn]))
                f.smooth = True

        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(mat)
        bind_object_to_bone(obj, arm_obj, "head")
        return obj

    # 外圈 4.5% 纤细深烟灰机械眼眶 + 内层饱满微凸六角蜂窝光学复眼
    rim_obj = build_eye_mesh("TigaEyeRim", scale_xy=1.055, lift_edge=0.0010, lift_center=0.0042, mat=mat_rim)
    eye_obj = build_eye_mesh("TigaEyesMesh", scale_xy=1.000, lift_edge=0.0020, lift_center=0.0115, mat=mat_eye)
    return eye_obj, rim_obj


def create_tiga_forehead_crystal(body_obj: bpy.types.Object, arm_obj: bpy.types.Object, bvh: BVHTree, mat_crystal, mat_silver):
    """
    在原厂眉心雕刻菱形凹槽正中心 (X=0, Z=3.004) 雕刻：
    - 亮银金属斜倒角镶框
    - 八面钻石切面冰白青宝石水晶
    """
    mw = body_obj.matrix_world
    mw_inv = mw.inverted()
    cx, cz = 0.0, 3.0045
    w_loc, w_norm = project_onto_body(bvh, mw, mw_inv, cx, cz)
    if w_loc is None:
        w_loc = Vector((0.0, -0.188, cz))
        w_norm = Vector((0.0, -0.96, 0.25)).normalized()

    # 构建贴合额头斜度的局部正交基 (t_right, t_up, n_out)
    n_out = w_norm.normalized()
    t_right = Vector((1.0, 0.0, 0.0))
    t_up = n_out.cross(t_right).normalized()
    t_right = t_up.cross(n_out).normalized()

    def build_diamond(name: str, half_w: float, half_h: float, base_lift: float, peak_lift: float, mat):
        bm = bmesh.new()
        # 4 个菱形外角点（沉入额面 0.003m 杜绝缝隙）+ 4 个表层倒角点 + 1 个中心宝石尖顶
        corners_2d = [(0.0, half_h), (half_w, 0.0), (0.0, -half_h), (-half_w, 0.0)]
        ring_in = []
        ring_top = []
        for ux, uz in corners_2d:
            p_base = w_loc + t_right * ux + t_up * uz - n_out * 0.0035
            p_top = w_loc + t_right * (ux * 0.92) + t_up * (uz * 0.92) + n_out * base_lift
            ring_in.append(bm.verts.new(p_base))
            ring_top.append(bm.verts.new(p_top))
        v_peak = bm.verts.new(w_loc + n_out * peak_lift)

        for i in range(4):
            ni = (i + 1) % 4
            bm.faces.new((ring_in[i], ring_in[ni], ring_top[ni], ring_top[i]))
            f_tri = bm.faces.new((ring_top[i], ring_top[ni], v_peak))
            f_tri.smooth = False  # 宝石切面保持锐利棱线折射高光！

        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(mat)
        bind_object_to_bone(obj, arm_obj, "head")
        return obj

    frame_obj = build_diamond("TigaCrystalFrame", half_w=0.0205, half_h=0.0445, base_lift=0.0032, peak_lift=0.0046, mat=mat_silver)
    crys_obj = build_diamond("TigaForeheadCrystal", half_w=0.0155, half_h=0.0365, base_lift=0.0045, peak_lift=0.0105, mat=mat_crystal)
    return crys_obj, frame_obj


def create_tiga_chest_color_timer(
    body_obj: bpy.types.Object,
    arm_obj: bpy.types.Object,
    bvh: BVHTree,
    mat_silver,
    mat_rim,
    mat_timer,
):
    """
    原位高精雕刻迪迦标志性「尖菱盾牌彩色计时器」并蒙皮绑定至 spineChest：
    - 外层亮银金属上宽下尖立体盾牌底座（严密嵌入胸甲 V 字中心 Z=2.362）
    - 中层深烟灰机械金属内环槽
    - 核心晶莹饱满多面切面宝石能量灯（材质名 Tiga color timer，原生驱动冰蓝呼吸与危急红灯急闪）
    """
    mw = body_obj.matrix_world
    mw_inv = mw.inverted()
    # 精准对齐胸甲前 V 字正中（实测 z=2.35 为胸甲最前凸尖端，计时器核心中心定于 z=2.382，下尖直抵 z=2.295 完美收进 V 尖）
    cz = 2.382
    w_loc, w_norm = project_onto_body(bvh, mw, mw_inv, 0.0, cz)
    if w_loc is None:
        w_loc = Vector((0.0, -0.236, cz))
        w_norm = Vector((0.0, -0.97, 0.22)).normalized()

    n_out = w_norm.normalized()
    t_right = Vector((1.0, 0.0, 0.0))
    t_up = n_out.cross(t_right).normalized()
    t_right = t_up.cross(n_out).normalized()

    # 严格分层高程坐标系（基于中心锚点切平面，杜绝胸甲 V 折痕导致的局部穿模！）
    # 先计算盾牌区域最前突的平面基准点（确保整个银盾厚实包覆胸甲而不被胸甲刺穿）
    plane_origin = w_loc.copy()
    for ux, uz in ((0.0, 0.0), (0.025, 0.02), (-0.025, 0.02), (0.0, -0.045)):
        p_h, _ = project_onto_body(bvh, mw, mw_inv, ux, cz + uz)
        if p_h is not None and p_h.y < plane_origin.y:
            plane_origin.y = p_h.y

    def shield_pt(ux: float, uz: float, lift: float, hug_body: bool = False):
        if hug_body:
            guess = w_loc + t_right * ux + t_up * uz
            p_hit, n_hit = project_onto_body(bvh, mw, mw_inv, guess.x, guess.z)
            if p_hit is not None and n_hit is not None:
                return p_hit + n_hit * lift
        # 局部切平面坐标（略带优雅弧度随胸膛微弯，保证底座/内环/宝石三层严格分离零穿模）
        curve_back = (ux * ux) * 1.45
        return plane_origin + t_right * ux + t_up * uz + n_out * (lift - curve_back)

    # 1. 迪迦招牌「上宽圆肩、下收尖角」亮银盾牌底座 (TigaTimerShield)
    bm_shield = bmesh.new()
    shield_pts_2d = [
        (0.000,  0.064),
        (0.028,  0.056),
        (0.044,  0.032),
        (0.045,  0.000),
        (0.033, -0.036),
        (0.015, -0.068),
        (0.000, -0.090),
        (-0.015, -0.068),
        (-0.033, -0.036),
        (-0.045,  0.000),
        (-0.044,  0.032),
        (-0.028,  0.056),
    ]
    n_pts = len(shield_pts_2d)
    r_buried = [bm_shield.verts.new(shield_pt(ux * 1.05, uz * 1.05, -0.014, hug_body=True)) for ux, uz in shield_pts_2d]
    r_bevel = [bm_shield.verts.new(shield_pt(ux * 0.94, uz * 0.94, 0.009)) for ux, uz in shield_pts_2d]
    r_inner = [bm_shield.verts.new(shield_pt(ux * 0.72, uz * 0.72, 0.013)) for ux, uz in shield_pts_2d]
    v_mid = bm_shield.verts.new(shield_pt(0.0, -0.004, 0.011))

    for i in range(n_pts):
        ni = (i + 1) % n_pts
        f1 = bm_shield.faces.new((r_buried[i], r_buried[ni], r_bevel[ni], r_bevel[i]))
        f2 = bm_shield.faces.new((r_bevel[i], r_bevel[ni], r_inner[ni], r_inner[i]))
        f3 = bm_shield.faces.new((r_inner[i], r_inner[ni], v_mid))
        f1.smooth = False
        f2.smooth = False
        f3.smooth = False

    bmesh.ops.recalc_face_normals(bm_shield, faces=bm_shield.faces)
    mesh_s = bpy.data.meshes.new("TigaTimerShield")
    bm_shield.to_mesh(mesh_s)
    bm_shield.free()
    obj_shield = bpy.data.objects.new("TigaTimerShield", mesh_s)
    bpy.context.collection.objects.link(obj_shield)
    obj_shield.data.materials.append(mat_silver)
    bind_object_to_bone(obj_shield, arm_obj, "spineChest")

    # 2. 中层深烟灰金属内环框 (TigaTimerRing)：严格高出银盾 0.012~0.021，绝不穿插
    bm_ring = bmesh.new()
    segs = 32
    rx_r, rz_r = 0.0325, 0.0390
    ring_out = []
    ring_top = []
    ring_in = []
    for i in range(segs):
        th = (2.0 * math.pi * i) / segs
        ct, st = math.cos(th), math.sin(th)
        taper = 0.88 if st < 0 else 1.0
        ux = ct * rx_r * (1.0 - 0.14 * max(0.0, -st))
        uz = st * rz_r * taper + 0.005
        ring_out.append(bm_ring.verts.new(shield_pt(ux * 1.08, uz * 1.08, 0.010)))
        ring_top.append(bm_ring.verts.new(shield_pt(ux * 0.99, uz * 0.99, 0.020)))
        ring_in.append(bm_ring.verts.new(shield_pt(ux * 0.85, uz * 0.85, 0.016)))
    for i in range(segs):
        ni = (i + 1) % segs
        f1 = bm_ring.faces.new((ring_out[i], ring_out[ni], ring_top[ni], ring_top[i]))
        f2 = bm_ring.faces.new((ring_top[i], ring_top[ni], ring_in[ni], ring_in[i]))
        f1.smooth = True
        f2.smooth = True
    bmesh.ops.recalc_face_normals(bm_ring, faces=bm_ring.faces)
    mesh_r = bpy.data.meshes.new("TigaTimerRing")
    bm_ring.to_mesh(mesh_r)
    bm_ring.free()
    obj_ring = bpy.data.objects.new("TigaTimerRing", mesh_r)
    bpy.context.collection.objects.link(obj_ring)
    obj_ring.data.materials.append(mat_rim)
    bind_object_to_bone(obj_ring, arm_obj, "spineChest")

    # 3. 核心晶莹饱满宝石彩色计时器 (TigaTimerCore)：从 0.017 圆润穹起至 0.036，100% 饱满零破面
    bm_core = bmesh.new()
    uv_layer = bm_core.loops.layers.uv.new("UVMap")
    rings = 8
    rx_c, rz_c = 0.0285, 0.0342
    v_center = bm_core.verts.new(shield_pt(0.0, 0.005, 0.036))
    r_verts = []
    r_uvs = []
    for ri in range(1, rings + 1):
        rn = ri / rings
        vs = []
        us = []
        dome = math.sqrt(max(0.0, 1.0 - rn * rn))
        lift = 0.017 + 0.019 * (dome ** 0.78)
        for i in range(segs):
            th = (2.0 * math.pi * i) / segs
            ct, st = math.cos(th), math.sin(th)
            taper = 0.88 if st < 0 else 1.0
            ux = ct * rx_c * rn * (1.0 - 0.14 * max(0.0, -st))
            uz = st * rz_c * rn * taper + 0.005
            vs.append(bm_core.verts.new(shield_pt(ux, uz, lift)))
            us.append((0.5 + 0.48 * ct * rn, 0.5 + 0.48 * st * rn))
        r_verts.append(vs)
        r_uvs.append(us)

    for i in range(segs):
        ni = (i + 1) % segs
        f = bm_core.faces.new((v_center, r_verts[0][i], r_verts[0][ni]))
        f.smooth = True
        f.loops[0][uv_layer].uv = (0.5, 0.5)
        f.loops[1][uv_layer].uv = r_uvs[0][i]
        f.loops[2][uv_layer].uv = r_uvs[0][ni]
    for ri in range(rings - 1):
        for i in range(segs):
            ni = (i + 1) % segs
            f = bm_core.faces.new((r_verts[ri][i], r_verts[ri + 1][i], r_verts[ri + 1][ni], r_verts[ri][ni]))
            f.smooth = True
            f.loops[0][uv_layer].uv = r_uvs[ri][i]
            f.loops[1][uv_layer].uv = r_uvs[ri + 1][i]
            f.loops[2][uv_layer].uv = r_uvs[ri + 1][ni]
            f.loops[3][uv_layer].uv = r_uvs[ri][ni]

    bmesh.ops.recalc_face_normals(bm_core, faces=bm_core.faces)
    mesh_c = bpy.data.meshes.new("TigaTimerCore")
    bm_core.to_mesh(mesh_c)
    bm_core.free()
    obj_core = bpy.data.objects.new("TigaTimerCore", mesh_c)
    bpy.context.collection.objects.link(obj_core)
    obj_core.data.materials.append(mat_timer)
    bind_object_to_bone(obj_core, arm_obj, "spineChest")
    return obj_shield, obj_ring, obj_core


def rebuild_materials(body_obj: bpy.types.Object):
    """全面重制迪迦全部材质球为影视级全通道 PBR 材质"""
    img_suit_albedo = load_image("tiga_suit_albedo.png", "sRGB")
    img_suit_normal = load_image("tiga_suit_normal.png", "Non-Color")
    img_suit_orm = load_image("tiga_suit_orm.png", "Non-Color")
    img_silver_albedo = load_image("tiga_silver_albedo.png", "sRGB")
    img_gold_albedo = load_image("tiga_gold_albedo.png", "sRGB")
    img_metal_normal = load_image("tiga_metal_normal.png", "Non-Color")
    img_eye_albedo = load_image("tiga_eye_albedo.png", "sRGB")
    img_eye_emissive = load_image("tiga_eye_emissive.png", "sRGB")
    img_eye_normal = load_image("tiga_eye_normal.png", "Non-Color")
    img_timer_albedo = load_image("tiga_timer_albedo.png", "sRGB")
    img_timer_normal = load_image("tiga_timer_normal.png", "Non-Color")

    def reset_mat(name: str):
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out_n = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])
        return mat, nt, bsdf

    # 1. Tiga body Multi-Type (2K 特摄皮套：深皇室紫/浓正红/丝缎银 + 拼接凹缝法线 + ORM + 柔和清漆)
    _, nt, bsdf = reset_mat("Tiga body Multi-Type")
    t_col = nt.nodes.new("ShaderNodeTexImage"); t_col.image = img_suit_albedo
    t_orm = nt.nodes.new("ShaderNodeTexImage"); t_orm.image = img_suit_orm
    t_nrm = nt.nodes.new("ShaderNodeTexImage"); t_nrm.image = img_suit_normal
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nmap = nt.nodes.new("ShaderNodeNormalMap"); nmap.inputs["Strength"].default_value = 0.65

    nt.links.new(t_col.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(t_nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Coat Weight", 0.16)
    set_bsdf_input(bsdf, "Coat Roughness", 0.34)

    # 2. Tiga body silver (航空冷钛金属漆头盔、胸甲银边与银盾底座：标准贴图直连，glTF 100% 忠实导出零变灰)
    mat_silver, nt, bsdf = reset_mat("Tiga body silver")
    t_sa = nt.nodes.new("ShaderNodeTexImage"); t_sa.image = img_silver_albedo
    nt.links.new(t_sa.outputs["Color"], bsdf.inputs["Base Color"])
    set_bsdf_input(bsdf, "Metallic", 0.72)
    set_bsdf_input(bsdf, "Roughness", 0.24)
    set_bsdf_input(bsdf, "Coat Weight", 0.35)
    set_bsdf_input(bsdf, "Coat Roughness", 0.14)
    t_mn = nt.nodes.new("ShaderNodeTexImage"); t_mn.image = img_metal_normal
    nmap_s = nt.nodes.new("ShaderNodeNormalMap"); nmap_s.inputs["Strength"].default_value = 0.18
    nt.links.new(t_mn.outputs["Color"], nmap_s.inputs["Color"])
    nt.links.new(nmap_s.outputs["Normal"], bsdf.inputs["Normal"])

    # 3. Tiga body gold (24K 饱满香槟钛金双胸甲护条：标准贴图直连，100% 闪耀璀璨特摄真金！)
    _, nt, bsdf = reset_mat("Tiga body gold")
    t_ga = nt.nodes.new("ShaderNodeTexImage"); t_ga.image = img_gold_albedo
    nt.links.new(t_ga.outputs["Color"], bsdf.inputs["Base Color"])
    set_bsdf_input(bsdf, "Metallic", 0.86)
    set_bsdf_input(bsdf, "Roughness", 0.20)
    set_bsdf_input(bsdf, "Coat Weight", 0.45)
    set_bsdf_input(bsdf, "Coat Roughness", 0.12)
    t_mn2 = nt.nodes.new("ShaderNodeTexImage"); t_mn2.image = img_metal_normal
    nmap_g = nt.nodes.new("ShaderNodeNormalMap"); nmap_g.inputs["Strength"].default_value = 0.20
    nt.links.new(t_mn2.outputs["Color"], nmap_g.inputs["Color"])
    nt.links.new(nmap_g.outputs["Normal"], bsdf.inputs["Normal"])

    # 4. Tiga eyes (1K 六角蜂窝钻石光学复眼 + 真实棱镜法线 + 温润暖奶金自发光)
    mat_eye, nt, bsdf = reset_mat("Tiga eyes")
    t_ec = nt.nodes.new("ShaderNodeTexImage"); t_ec.image = img_eye_albedo
    t_ee = nt.nodes.new("ShaderNodeTexImage"); t_ee.image = img_eye_emissive
    t_en = nt.nodes.new("ShaderNodeTexImage"); t_en.image = img_eye_normal
    nmap_e = nt.nodes.new("ShaderNodeNormalMap"); nmap_e.inputs["Strength"].default_value = 0.48
    nt.links.new(t_ec.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_ee.outputs["Color"], bsdf.inputs["Emission Color"])
    nt.links.new(t_en.outputs["Color"], nmap_e.inputs["Color"])
    nt.links.new(nmap_e.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Metallic", 0.05)
    set_bsdf_input(bsdf, "Roughness", 0.14)
    set_bsdf_input(bsdf, "Emission Strength", 0.92)
    set_bsdf_input(bsdf, "Coat Weight", 0.85)
    set_bsdf_input(bsdf, "Coat Roughness", 0.06)

    # 5. Tiga eye rim (深烟灰机械眼眶凹槽 & 胸口计时器深金属内环)
    mat_rim, nt, bsdf = reset_mat("Tiga eye rim")
    set_bsdf_input(bsdf, "Base Color", (0.09, 0.11, 0.14, 1.0))
    set_bsdf_input(bsdf, "Metallic", 0.72)
    set_bsdf_input(bsdf, "Roughness", 0.34)

    # 6. Tiga forehead crystal (额头眉心清澈蓝紫宝石水晶，一眼辨识迪迦标志性额灯！)
    mat_crystal, nt, bsdf = reset_mat("Tiga forehead crystal")
    set_bsdf_input(bsdf, "Base Color", (0.62, 0.80, 1.0, 1.0))
    set_bsdf_input(bsdf, "Metallic", 0.18)
    set_bsdf_input(bsdf, "Roughness", 0.06)
    set_bsdf_input(bsdf, "Emission Color", (0.48, 0.78, 1.0, 1.0))
    set_bsdf_input(bsdf, "Emission Strength", 1.15)
    set_bsdf_input(bsdf, "Coat Weight", 1.0)
    set_bsdf_input(bsdf, "Coat Roughness", 0.04)

    # 7. Tiga color timer (胸口多面宝石切割能量灯，保留名称供引擎实时控制冰蓝呼吸/红灯急闪)
    mat_timer, nt, bsdf = reset_mat("Tiga color timer")
    t_tc = nt.nodes.new("ShaderNodeTexImage"); t_tc.image = img_timer_albedo
    t_tn = nt.nodes.new("ShaderNodeTexImage"); t_tn.image = img_timer_normal
    nmap_t = nt.nodes.new("ShaderNodeNormalMap"); nmap_t.inputs["Strength"].default_value = 0.65
    nt.links.new(t_tc.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_tn.outputs["Color"], nmap_t.inputs["Color"])
    nt.links.new(nmap_t.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Metallic", 0.08)
    set_bsdf_input(bsdf, "Roughness", 0.10)
    set_bsdf_input(bsdf, "Emission Color", (0.22, 0.88, 1.0, 1.0))
    set_bsdf_input(bsdf, "Emission Strength", 1.45)
    set_bsdf_input(bsdf, "Coat Weight", 1.0)
    set_bsdf_input(bsdf, "Coat Roughness", 0.04)

    return mat_silver, mat_eye, mat_rim, mat_crystal, mat_timer


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=ORIG_GLB)
    bpy.context.view_layer.update()

    # 1. 彻底清除废节点 Icosphere 及原厂错位损坏的旧眼、旧计时器
    remove_names = {"Icosphere", "TigaEyes", "TigaEnergy", "TigaEnergyContainer"}
    for obj in list(bpy.data.objects):
        if obj.name in remove_names or any(k in obj.name for k in ("Icosphere", "TigaEyes", "TigaEnergy")):
            bpy.data.objects.remove(obj, do_unlink=True)

    body_obj = bpy.data.objects.get("TigaBody")
    arm_obj = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    assert body_obj and arm_obj, "缺少 TigaBody 或 Armature"

    # 2. 影视级微雕头型/胸甲/身材比例（零破坏 52 骨权重）
    sculpt_tiga_body_proportions(body_obj)

    # 3. 为银甲/金甲槽铺设干净盒式 UV（金属微粒法线与拉丝反光均匀无拉伸）
    mat_names = [s.material.name if s.material else "" for s in body_obj.material_slots]
    metal_slots = {i for i, n in enumerate(mat_names) if "silver" in n.lower() or "gold" in n.lower()}
    generate_box_uv_for_slots(body_obj, metal_slots, scale=3.5)

    # 4. 升级全套 PBR 材质球
    mat_silver, mat_eye, mat_rim, mat_crystal, mat_timer = rebuild_materials(body_obj)

    # 5. 构建微雕后 TigaBody 的精确 BVHTree，原位贴面雕刻复眼、眉心水晶、胸口尖菱盾牌彩色计时器
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body_obj, depsgraph)

    create_tiga_sculpted_eyes(body_obj, arm_obj, bvh, mat_eye, mat_rim)
    create_tiga_forehead_crystal(body_obj, arm_obj, bvh, mat_crystal, mat_silver)
    create_tiga_chest_color_timer(body_obj, arm_obj, bvh, mat_silver, mat_rim, mat_timer)

    bpy.context.view_layer.update()

    # 6. 清理未使用孤立数据块并导出标准 Y-Up GLB
    bpy.ops.outliner.orphans_purge(do_recursive=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=90,
        export_skins=True,
        export_animations=False,
        export_attributes=True,
    )
    print(f"✓ 影视级高保真迪迦已导出: {OUT_GLB} ({os.path.getsize(OUT_GLB) // 1024} KB)")


if __name__ == "__main__":
    main()
