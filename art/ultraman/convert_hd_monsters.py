"""
Blender 5.2 无头脚本：将 5 大高清奥特曼怪兽源模统一转换为游戏标准高保真 PBR GLB

资产来源：/Users/jin/work-person/fun4gulu/资源/奥特曼怪兽高清学习包
输出产物（覆盖旧低模，保持前端 URL 零变动）：
- ui/public/models/ultraman/baltan.glb       （巴尔坦星人高清 FBX + 法线/金属/复眼发光）
- ui/public/models/ultraman/gomora-mecha.glb （机械哥莫拉高清 FBX + 眼/角/胸炮发光 + 衍生法线）
- ui/public/models/ultraman/gatanothor.glb   （邪神加坦杰厄高清 FBX + 壳甲法线/触手材质）
- ui/public/models/ultraman/ganq.glb         （奇兽加恩Q 21骨 PMX + 湿润眼球高光 + 衍生法线）
- ui/public/models/ultraman/zetton.glb       （海帕杰顿 11.6K 面 69 骨 PMX + 法线 + 全身发光贴图）

统一坐标契约：
- 正面朝向 Blender -Y（export_yup=True 导出后对应 Three.js +Z，正对奥特曼）
- 底面严格接地 Blender Z = 0，水平中心归零
"""

import math
import os
import struct
import tempfile
import bpy
import numpy as np
from mathutils import Vector, Matrix

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
PACK_ROOT = os.path.join(REPO_ROOT, "资源", "奥特曼怪兽高清学习包")
OUT_DIR = os.path.join(REPO_ROOT, "ui", "public", "models", "ultraman")
os.makedirs(OUT_DIR, exist_ok=True)


def clear_scene_objects():
    """清空场景对象与数据块（保留 Blender 内置 FBX/glTF 插件）"""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.actions,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)
            else:
                try:
                    coll.remove(item, do_unlink=True)
                except Exception:
                    pass


def get_bsdf(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    nt.nodes.clear()
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def set_bsdf(bsdf, name, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def load_packed_image(path: str, colorspace: str = "sRGB", max_dim: int = 1024):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    if max(w, h) > max_dim and w > 0 and h > 0:
        scale = max_dim / float(max(w, h))
        img.scale(max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def make_normal_from_albedo(src_path: str, name: str, tmp_dir: str, strength: float = 1.85):
    """基于高精度漫反射贴图衍生微凹凸切线空间法线贴图"""
    img = bpy.data.images.load(src_path, check_existing=False)
    w, h = img.size
    arr = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    lum = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114
    gx = np.roll(lum, -1, axis=1) - np.roll(lum, 1, axis=1)
    gy = np.roll(lum, -1, axis=0) - np.roll(lum, 1, axis=0)
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(lum, dtype=np.float32)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, 0] = nx * inv * 0.5 + 0.5
    rgba[:, :, 1] = ny * inv * 0.5 + 0.5
    rgba[:, :, 2] = nz * inv * 0.5 + 0.5

    tmp_img = bpy.data.images.new(name=f"_tmp_{name}", width=w, height=h, alpha=True)
    tmp_img.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).ravel())
    out_p = os.path.join(tmp_dir, f"{name}.png")
    tmp_img.filepath_raw = out_p
    tmp_img.file_format = "PNG"
    tmp_img.save()
    bpy.data.images.remove(tmp_img)
    return load_packed_image(out_p, "Non-Color")


def build_pbr_mat(
    name: str,
    base_img=None,
    normal_img=None,
    normal_strength: float = 0.85,
    metal_img=None,
    emissive_img=None,
    emissive_strength: float = 0.0,
    emissive_color=None,
    roughness: float = 0.52,
    metallic: float = 0.12,
    coat_weight: float = 0.0,
    coat_roughness: float = 0.18,
    alpha_blend: bool = False,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    set_bsdf(bsdf, "Roughness", roughness)
    set_bsdf(bsdf, "Metallic", metallic)
    if coat_weight > 0:
        set_bsdf(bsdf, "Coat Weight", coat_weight)
        set_bsdf(bsdf, "Coat Roughness", coat_roughness)

    if base_img is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = base_img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_blend:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])

    if normal_img is not None:
        ntex = nt.nodes.new("ShaderNodeTexImage")
        ntex.image = normal_img
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    if metal_img is not None:
        mtex = nt.nodes.new("ShaderNodeTexImage")
        mtex.image = metal_img
        nt.links.new(mtex.outputs["Color"], bsdf.inputs["Metallic"])

    if emissive_img is not None and emissive_strength > 0:
        etex = nt.nodes.new("ShaderNodeTexImage")
        etex.image = emissive_img
        nt.links.new(etex.outputs["Color"], bsdf.inputs["Emission Color"])
        set_bsdf(bsdf, "Emission Strength", emissive_strength)
    elif emissive_color is not None and emissive_strength > 0:
        set_bsdf(bsdf, "Emission Color", (*emissive_color, 1.0))
        set_bsdf(bsdf, "Emission Strength", emissive_strength)

    return mat


def normalize_root_and_export(out_filename: str, target_height: float, subdiv_levels: int = 0):
    """将当前场景中全部骨架与网格统一归一化至目标高度、接地 Z=0、居中并导出标准 GLB"""
    bpy.context.view_layer.update()

    # 清除空摄像机/灯光干扰
    for obj in list(bpy.data.objects):
        if obj.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(obj, do_unlink=True)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]

    # 开启平滑着色并可选 1 级细分（保留骨架蒙皮权重，仅用于超低面优质拓扑模型如巴尔坦/加坦杰厄/加恩Q）
    for m in meshes:
        if len(m.data.polygons) > 0:
            m.data.polygons.foreach_set("use_smooth", [True] * len(m.data.polygons))
        if subdiv_levels > 0:
            bpy.ops.object.select_all(action="DESELECT")
            m.select_set(True)
            bpy.context.view_layer.objects.active = m
            mod = m.modifiers.new(name="SubsurfHD", type="SUBSURF")
            mod.levels = subdiv_levels
            mod.render_levels = subdiv_levels
            mod.uv_smooth = "PRESERVE_CORNERS"
            bpy.ops.object.modifier_apply(modifier=mod.name)

    bpy.context.view_layer.update()
    xs, ys, zs = [], [], []
    for m in meshes:
        for c in m.bound_box:
            w = m.matrix_world @ Vector(c)
            xs.append(w.x)
            ys.append(w.y)
            zs.append(w.z)

    h = max(1e-5, max(zs) - min(zs))
    scale_f = target_height / h
    cx = (min(xs) + max(xs)) * 0.5
    cy = (min(ys) + max(ys)) * 0.5
    min_z = min(zs)

    # 挂接至顶层归零根节点进行统一缩放与接地（完美兼容带父子关系的 FBX 骨架）
    roots = [o for o in bpy.data.objects if o.parent is None]
    norm_empty = bpy.data.objects.new("MonsterNormalizedRoot", None)
    bpy.context.collection.objects.link(norm_empty)
    norm_empty.location = (0.0, 0.0, 0.0)

    for r in roots:
        # 先把顶层对象移回原点并乘统一缩放
        r.parent = norm_empty
        r.matrix_parent_inverse = Matrix.Identity(4)

    norm_empty.scale = (scale_f, scale_f, scale_f)
    norm_empty.location = (-cx * scale_f, -cy * scale_f, -min_z * scale_f)
    bpy.context.view_layer.update()

    # 选中全部网格和骨架导出
    bpy.ops.object.select_all(action="DESELECT")
    norm_empty.select_set(True)
    for o in bpy.data.objects:
        if o.type in ("MESH", "ARMATURE", "EMPTY"):
            o.select_set(True)

    out_path = os.path.join(OUT_DIR, out_filename)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=88,
        export_skins=True,
        export_animations=False,
        use_selection=True,
    )

    total_tris = sum(len(m.data.polygons) for m in meshes)
    total_bones = sum(len(a.data.bones) for a in arms)
    size_kb = os.path.getsize(out_path) / 1024.0
    print(f"[Exported] {out_filename:18s} | polys={total_tris:6d} | bones={total_bones:3d} | size={size_kb:7.1f} KB")


# ---------------- PMX 2.0 解析器（用于加恩Q 与 海帕杰顿） ----------------

def parse_pmx(path: str):
    with open(path, "rb") as f:
        sig = f.read(4)
        if sig != b"PMX ":
            raise ValueError(f"非法 PMX 文件头: {sig!r}")
        _ver = struct.unpack("<f", f.read(4))[0]
        g_cnt = struct.unpack("<B", f.read(1))[0]
        g = list(f.read(g_cnt))
        enc = "utf-16-le" if g[0] == 0 else "utf-8"
        add_uv, v_sz, t_sz, m_sz, b_sz = g[1:6]

        def read_text() -> str:
            n = struct.unpack("<i", f.read(4))[0]
            return f.read(n).decode(enc, errors="replace")

        def read_idx(sz: int, unsigned: bool = False) -> int:
            if sz == 1:
                return struct.unpack("<B" if unsigned else "<b", f.read(1))[0]
            if sz == 2:
                return struct.unpack("<H" if unsigned else "<h", f.read(2))[0]
            return struct.unpack("<i", f.read(4))[0]

        read_text(); read_text(); read_text(); read_text()
        v_cnt = struct.unpack("<i", f.read(4))[0]
        verts, normals, uvs, weights = [], [], [], []
        for _ in range(v_cnt):
            x, y, z, nx, ny, nz, u, v = struct.unpack("<8f", f.read(32))
            if add_uv > 0:
                f.read(16 * add_uv)
            wt = struct.unpack("<B", f.read(1))[0]
            w_list = []
            if wt == 0:
                b0 = read_idx(b_sz)
                if b0 >= 0:
                    w_list.append((b0, 1.0))
            elif wt == 1:
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            elif wt in (2, 4):
                bs = [read_idx(b_sz) for _ in range(4)]
                ws = struct.unpack("<4f", f.read(16))
                for b, w in zip(bs, ws):
                    if b >= 0 and w > 1e-6:
                        w_list.append((b, w))
            elif wt == 3:
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                f.read(36)
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            f.read(4)
            verts.append((x, y, z))
            normals.append((nx, ny, nz))
            uvs.append((u, v))
            weights.append(w_list)

        i_cnt = struct.unpack("<i", f.read(4))[0]
        indices = [read_idx(v_sz, unsigned=True) for _ in range(i_cnt)]
        tex_cnt = struct.unpack("<i", f.read(4))[0]
        textures = [read_text() for _ in range(tex_cnt)]

        mat_cnt = struct.unpack("<i", f.read(4))[0]
        materials = []
        cursor = 0
        for _ in range(mat_cnt):
            mn = read_text(); read_text()
            diff = struct.unpack("<4f", f.read(16))
            f.read(12 + 4 + 12 + 1 + 20)
            tex_i = read_idx(t_sz); read_idx(t_sz); f.read(1)
            tf = struct.unpack("<B", f.read(1))[0]
            if tf == 1:
                f.read(1)
            else:
                read_idx(t_sz)
            read_text()
            fcnt = struct.unpack("<i", f.read(4))[0]
            materials.append({
                "name": mn,
                "diffuse": diff,
                "texture": textures[tex_i] if 0 <= tex_i < len(textures) else None,
                "index_start": cursor,
                "index_count": fcnt,
            })
            cursor += fcnt

        bone_cnt = struct.unpack("<i", f.read(4))[0]
        bones = []
        for idx in range(bone_cnt):
            bn = read_text(); be = read_text()
            pos = struct.unpack("<3f", f.read(12))
            parent = read_idx(b_sz); f.read(4)
            flag = struct.unpack("<H", f.read(2))[0]
            if flag & 0x0001:
                read_idx(b_sz)
            else:
                f.read(12)
            if (flag & 0x0100) or (flag & 0x0200):
                read_idx(b_sz); f.read(4)
            if flag & 0x0400:
                f.read(12)
            if flag & 0x0800:
                f.read(24)
            if flag & 0x2000:
                f.read(4)
            if flag & 0x0020:
                read_idx(b_sz); f.read(8)
                lcnt = struct.unpack("<i", f.read(4))[0]
                for _ in range(lcnt):
                    read_idx(b_sz)
                    if struct.unpack("<B", f.read(1))[0]:
                        f.read(24)
            bones.append({"idx": idx, "name": bn, "en": be, "pos": pos, "parent": parent})

    return {
        "verts": verts,
        "normals": normals,
        "uvs": uvs,
        "weights": weights,
        "indices": indices,
        "materials": materials,
        "bones": bones,
    }


def build_pmx_armature_and_mesh(pmx_data, obj_name: str, mat_builder_fn):
    """将 PMX 2.0 坐标（X 右 / Y 上 / Z 后）精确转换至 Blender（X 右 / Y 后 / Z 上，正面 -Y）并构建完整骨骼蒙皮"""
    def to_bl(p):
        # PMX 左手系 (x, y, z) 其中 -z 为前；转换至 Blender 右手系 (x, z, y) 恰好 -Y 朝前！
        return (-p[0], p[2], p[1])

    def to_bl_n(n):
        v = Vector((-n[0], n[2], n[1]))
        return v.normalized() if v.length > 1e-6 else Vector((0, -1, 0))

    # 1. 创建骨架
    arm_data = bpy.data.armatures.new(f"{obj_name}Armature")
    arm_obj = bpy.data.objects.new(f"{obj_name}Armature", arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    bones_raw = pmx_data["bones"]
    edit_bones = {}
    children_map = {i: [] for i in range(len(bones_raw))}
    for b in bones_raw:
        p = b["parent"]
        if 0 <= p < len(bones_raw) and p != b["idx"]:
            children_map[p].append(b["idx"])

    # 去重骨名
    used_names = {}
    std_names = []
    for b in bones_raw:
        raw_n = b["name"].strip() or f"Bone_{b['idx']}"
        if raw_n in used_names:
            used_names[raw_n] += 1
            unique_n = f"{raw_n}_{used_names[raw_n]}"
        else:
            used_names[raw_n] = 0
            unique_n = raw_n
        std_names.append(unique_n)

    for b in bones_raw:
        idx = b["idx"]
        eb = arm_data.edit_bones.new(std_names[idx])
        head = Vector(to_bl(b["pos"]))
        eb.head = head
        kids = children_map[idx]
        if kids:
            avg_kid = Vector((0.0, 0.0, 0.0))
            for k in kids:
                avg_kid += Vector(to_bl(bones_raw[k]["pos"]))
            avg_kid /= len(kids)
            if (avg_kid - head).length > 1e-3:
                eb.tail = avg_kid
            else:
                eb.tail = head + Vector((0.0, 0.0, 0.25))
        else:
            eb.tail = head + Vector((0.0, 0.0, 0.25))
        edit_bones[idx] = eb

    for b in bones_raw:
        p = b["parent"]
        if 0 <= p < len(bones_raw) and p != b["idx"]:
            edit_bones[b["idx"]].parent = edit_bones[p]

    bpy.ops.object.mode_set(mode="OBJECT")

    # 2. 构建网格
    verts_bl = [to_bl(v) for v in pmx_data["verts"]]
    indices = pmx_data["indices"]
    faces = []
    face_mats = []
    mat_objs = []

    for m_idx, m in enumerate(pmx_data["materials"]):
        mat_objs.append(mat_builder_fn(m))
        start = m["index_start"]
        cnt = m["index_count"]
        for k in range(start, start + cnt, 3):
            i0, i1, i2 = indices[k], indices[k + 1], indices[k + 2]
            if i0 == i1 or i1 == i2 or i0 == i2:
                continue
            # PMX -> Blender X 取反导致镜像，反转绕序保持外法线朝外
            faces.append((i0, i2, i1))
            face_mats.append(m_idx)

    mesh_data = bpy.data.meshes.new(obj_name)
    mesh_data.from_pydata(verts_bl, [], faces)
    for m_obj in mat_objs:
        mesh_data.materials.append(m_obj)
    for fi, poly in enumerate(mesh_data.polygons):
        poly.material_index = face_mats[fi]
        poly.use_smooth = True

    uv_layer = mesh_data.uv_layers.new(name="UVMap")
    uvs = pmx_data["uvs"]
    for loop in mesh_data.loops:
        u, v = uvs[loop.vertex_index]
        uv_layer.data[loop.index].uv = (u, 1.0 - v)

    mesh_data.update()
    mesh_obj = bpy.data.objects.new(obj_name, mesh_data)
    bpy.context.collection.objects.link(mesh_obj)

    # 绑定顶点组权重
    vgroups = {}
    for b_idx, b_name in enumerate(std_names):
        vgroups[b_idx] = mesh_obj.vertex_groups.new(name=b_name)
    for v_idx, wl in enumerate(pmx_data["weights"]):
        total_w = sum(w for _, w in wl)
        if total_w <= 1e-6:
            continue
        for b_idx, w in wl:
            if b_idx in vgroups:
                vgroups[b_idx].add([v_idx], w / total_w, "ADD")

    mesh_obj.parent = arm_obj
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    return arm_obj, mesh_obj


# ---------------- 5 只高清怪兽独立精修导出函数 ----------------

def convert_baltan(tmp_dir: str):
    """1. 巴尔坦星人（高精 PBR 法线/金属/复眼荧光 + 1级细分平滑）"""
    clear_scene_objects()
    d = os.path.join(PACK_ROOT, "01_巴尔坦星人_Baltan", "Alien Baltan")
    bpy.ops.wm.fbx_import(filepath=os.path.join(d, "Alien_Baltan.fbx"))

    base_img = load_packed_image(os.path.join(d, "Race_416.png"), "sRGB")
    norm_img = load_packed_image(os.path.join(d, "Race_416_n.png"), "Non-Color")
    metal_img = load_packed_image(os.path.join(d, "Race_416_m.png"), "Non-Color")

    # 从 BaseColor 精准提取巴尔坦亮黄复眼像素作为自发光贴图
    raw_img = bpy.data.images.load(os.path.join(d, "Race_416.png"), check_existing=False)
    w, h = raw_img.size
    arr = np.array(raw_img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(raw_img)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    eye_mask = np.clip((r - 0.55) * 3.0, 0, 1) * np.clip((g - 0.45) * 3.0, 0, 1) * np.clip((0.45 - b) * 4.0, 0, 1)
    em_rgba = np.zeros((h, w, 4), dtype=np.float32)
    em_rgba[:, :, 0] = eye_mask * 1.0
    em_rgba[:, :, 1] = eye_mask * 0.85
    em_rgba[:, :, 2] = eye_mask * 0.25
    em_rgba[:, :, 3] = 1.0
    em_tmp = bpy.data.images.new("_tmp_baltan_em", width=w, height=h, alpha=True)
    em_tmp.pixels.foreach_set(em_rgba.ravel())
    em_path = os.path.join(tmp_dir, "baltan_em.png")
    em_tmp.filepath_raw = em_path
    em_tmp.file_format = "PNG"
    em_tmp.save()
    bpy.data.images.remove(em_tmp)
    em_img = load_packed_image(em_path, "sRGB")

    mat = build_pbr_mat(
        "BaltanChitinHD",
        base_img=base_img,
        normal_img=norm_img,
        normal_strength=1.1,
        metal_img=metal_img,
        emissive_img=em_img,
        emissive_strength=1.55,
        roughness=0.42,
        metallic=0.35,
        coat_weight=0.25,
    )
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.data.materials.clear()
            o.data.materials.append(mat)

    normalize_root_and_export("baltan.glb", target_height=16.0, subdiv_levels=1)


def convert_mecha_gomora(tmp_dir: str):
    """2. 机械哥莫拉（高清 FBX + 眼/角/胸炮全套专用 Glowmap + 衍生机械装甲法线）"""
    clear_scene_objects()
    d = os.path.join(PACK_ROOT, "02_机械哥莫拉_MechaGomora", "Mecha Gomora (Ulbat) (MMDCharizard)")
    bpy.ops.import_scene.fbx(filepath=os.path.join(d, "MechaGomoraRiggingF.fbx"))

    tex_body = load_packed_image(os.path.join(d, "Tex_0113_1NEW3.png"), "sRGB")
    norm_body = make_normal_from_albedo(os.path.join(d, "Tex_0113_1NEW3.png"), "gomora_body_n", tmp_dir, 1.9)
    glow_eyes = load_packed_image(os.path.join(d, "MechaGomora-Glowmap-Eyes.png"), "sRGB")
    glow_chest = load_packed_image(os.path.join(d, "MechaGomora-Glowmap-Chest.png"), "sRGB")
    glow_all = load_packed_image(os.path.join(d, "MechaGomora-Glowmap.png"), "sRGB")

    mat_body = build_pbr_mat(
        "MechaGomoraArmorHD",
        base_img=tex_body,
        normal_img=norm_body,
        normal_strength=1.0,
        emissive_img=glow_all,
        emissive_strength=0.68,
        roughness=0.36,
        metallic=0.62,
        coat_weight=0.22,
    )
    mat_eyes = build_pbr_mat(
        "MechaGomoraEyesHD",
        base_img=tex_body,
        emissive_img=glow_eyes,
        emissive_strength=1.75,
        roughness=0.14,
        metallic=0.2,
    )
    mat_chest = build_pbr_mat(
        "MechaGomoraChestCoreHD",
        base_img=tex_body,
        normal_img=norm_body,
        normal_strength=0.9,
        emissive_img=glow_chest,
        emissive_strength=1.45,
        roughness=0.28,
        metallic=0.68,
    )

    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        for idx, m in enumerate(o.data.materials):
            if not m:
                continue
            ml = m.name.lower()
            if "eye" in ml:
                o.data.materials[idx] = mat_eyes
            elif "chest" in ml:
                o.data.materials[idx] = mat_chest
            else:
                o.data.materials[idx] = mat_body

    normalize_root_and_export("gomora-mecha.glb", target_height=16.8, subdiv_levels=0)


def convert_gatanothor(tmp_dir: str):
    """3. 邪神加坦杰厄（高精 FBX + 甲壳法线贴图 + 暗紫邪光口器/双目 + 1级细分平滑）"""
    clear_scene_objects()
    d = os.path.join(PACK_ROOT, "03_加坦杰厄_Gatanothor", "Gatanothor Gatanozoa")
    bpy.ops.wm.fbx_import(filepath=os.path.join(d, "Gatanothor_Gatanozoa.fbx"))

    base_body = load_packed_image(os.path.join(d, "Race_653.png"), "sRGB")
    norm_body = load_packed_image(os.path.join(d, "Race_653_n.png"), "Non-Color")
    base_wq = load_packed_image(os.path.join(d, "Race_653_wq.png"), "sRGB")
    norm_wq = make_normal_from_albedo(os.path.join(d, "Race_653_wq.png"), "gatanothor_wq_n", tmp_dir, 1.8)

    # 提取红色/亮橙眼睛区域微发光
    raw_img = bpy.data.images.load(os.path.join(d, "Race_653.png"), check_existing=False)
    w, h = raw_img.size
    arr = np.array(raw_img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(raw_img)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    glow_m = np.clip((r - 0.55) * 3.5, 0, 1) * np.clip((r - g - 0.12) * 4.0, 0, 1) * np.clip((r - b - 0.15) * 4.0, 0, 1)
    em_rgba = np.zeros((h, w, 4), dtype=np.float32)
    em_rgba[:, :, 0] = glow_m * 1.0
    em_rgba[:, :, 1] = glow_m * 0.25
    em_rgba[:, :, 2] = glow_m * 0.45
    em_rgba[:, :, 3] = 1.0
    em_tmp = bpy.data.images.new("_tmp_gat_em", width=w, height=h, alpha=True)
    em_tmp.pixels.foreach_set(em_rgba.ravel())
    em_path = os.path.join(tmp_dir, "gat_em.png")
    em_tmp.filepath_raw = em_path
    em_tmp.file_format = "PNG"
    em_tmp.save()
    bpy.data.images.remove(em_tmp)
    em_img = load_packed_image(em_path, "sRGB")

    mat_main = build_pbr_mat(
        "GatanothorShellHD",
        base_img=base_body,
        normal_img=norm_body,
        normal_strength=1.2,
        emissive_img=em_img,
        emissive_strength=1.4,
        roughness=0.58,
        metallic=0.14,
        coat_weight=0.18,
    )
    mat_wq = build_pbr_mat(
        "GatanothorTentacleHD",
        base_img=base_wq,
        normal_img=norm_wq,
        normal_strength=1.0,
        roughness=0.46,
        metallic=0.1,
        coat_weight=0.35,
    )

    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        for idx, m in enumerate(o.data.materials):
            if not m:
                continue
            if "wq" in m.name.lower():
                o.data.materials[idx] = mat_wq
            else:
                o.data.materials[idx] = mat_main

    normalize_root_and_export("gatanothor.glb", target_height=19.2, subdiv_levels=1)


def convert_ganq(tmp_dir: str):
    """4. 奇兽加恩Q（21 根完整骨骼 PMX + 高清表皮法线 + 湿润紫瞳清漆反光 + 1级细分平滑）"""
    clear_scene_objects()
    d = os.path.join(PACK_ROOT, "04_加恩Q_GanQ", "extracted", "Gan-Q")
    pmx_data = parse_pmx(os.path.join(d, "Gan-Q.pmx"))

    tex_path = os.path.join(d, "Tex_GanQ body_D.png")
    base_img = load_packed_image(tex_path, "sRGB")
    norm_img = make_normal_from_albedo(tex_path, "ganq_body_n", tmp_dir, 2.0)

    # 提取眼球虹膜红/紫高饱和区域加微妙邪光
    raw_img = bpy.data.images.load(tex_path, check_existing=False)
    w, h = raw_img.size
    arr = np.array(raw_img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(raw_img)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    iris = np.clip((r - g - 0.18) * 3.2, 0, 1) * np.clip((r - 0.4) * 2.5, 0, 1)
    em_rgba = np.zeros((h, w, 4), dtype=np.float32)
    em_rgba[:, :, 0] = iris * 0.92
    em_rgba[:, :, 1] = iris * 0.18
    em_rgba[:, :, 2] = iris * 0.78
    em_rgba[:, :, 3] = 1.0
    em_tmp = bpy.data.images.new("_tmp_ganq_em", width=w, height=h, alpha=True)
    em_tmp.pixels.foreach_set(em_rgba.ravel())
    em_path = os.path.join(tmp_dir, "ganq_em.png")
    em_tmp.filepath_raw = em_path
    em_tmp.file_format = "PNG"
    em_tmp.save()
    bpy.data.images.remove(em_tmp)
    em_img = load_packed_image(em_path, "sRGB")

    mat = build_pbr_mat(
        "GanQOrganicHD",
        base_img=base_img,
        normal_img=norm_img,
        normal_strength=1.05,
        emissive_img=em_img,
        emissive_strength=0.9,
        roughness=0.38,
        metallic=0.06,
        coat_weight=0.52,
        coat_roughness=0.1,
    )
    build_pmx_armature_and_mesh(pmx_data, "GanQHD", lambda _m: mat)
    normalize_root_and_export("ganq.glb", target_height=16.8, subdiv_levels=1)


def convert_hyper_zetton():
    """5. 海帕杰顿（11,616 面 69 根骨骼 PMX + 原厂法线贴图 + 独立五区高亮发光贴图）"""
    clear_scene_objects()
    d = os.path.join(PACK_ROOT, "05_海帕杰顿_HyperZetton", "Hyper Zetton (MMDCharizard)")
    pmx_data = parse_pmx(os.path.join(d, "Hyper Zetton Kaiju Size (100 meters).pmx"))

    base_img = load_packed_image(os.path.join(d, "Hyper_Zetton2.png"), "sRGB")
    norm_img = load_packed_image(os.path.join(d, "Hyper_Zetton_nm2.png"), "Non-Color")
    glow_img = load_packed_image(os.path.join(d, "Hyper_ZettonGlow2.png"), "sRGB")

    mat_body = build_pbr_mat(
        "HyperZettonCarapaceHD",
        base_img=base_img,
        normal_img=norm_img,
        normal_strength=1.15,
        roughness=0.28,
        metallic=0.42,
        coat_weight=0.45,
        coat_roughness=0.12,
    )
    mat_wings = build_pbr_mat(
        "HyperZettonWingsHD",
        base_img=base_img,
        normal_img=norm_img,
        normal_strength=0.9,
        emissive_img=glow_img,
        emissive_strength=0.65,
        roughness=0.32,
        metallic=0.36,
    )
    mat_glow = build_pbr_mat(
        "HyperZettonCoreGlowHD",
        base_img=glow_img,
        emissive_img=glow_img,
        emissive_strength=1.65,
        roughness=0.14,
        metallic=0.15,
    )

    def map_mat(m):
        mn = m["name"].lower()
        if "glow" in mn:
            return mat_glow
        if "wing" in mn:
            return mat_wings
        return mat_body

    build_pmx_armature_and_mesh(pmx_data, "HyperZettonHD", map_mat)
    normalize_root_and_export("zetton.glb", target_height=17.4, subdiv_levels=0)


def main():
    with tempfile.TemporaryDirectory() as tmp_dir:
        convert_baltan(tmp_dir)
        convert_mecha_gomora(tmp_dir)
        convert_gatanothor(tmp_dir)
        convert_ganq(tmp_dir)
        convert_hyper_zetton()
    print("=== ALL 5 HD MONSTER GLBs EXPORTED ===")


if __name__ == "__main__":
    main()
