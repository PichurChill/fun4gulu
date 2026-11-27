"""
Blender 5.2 无头脚本：
1. 赛罗奥特曼 (zero.glb)：整机换装官方正版游戏原模 Ultraman_Zero.fbx (Race_1201, 60 根完整 Bip001 骨骼+双锁骨+20指骨+双冰斧头雕) + 2K 影视级全通道 PBR
2. 戴拿奥特曼 (dyna.glb) & 泽塔奥特曼 (zeta.glb)：清理废节点 Icosphere，保留 100% 骨骼与蒙皮权重，全面升级 2K 锐化漫反射 + 2K 精准金属/皮套分层 ORM + 2K 微肌理法线 + 1K 高锐度自发光
"""
import os
import bpy
from mathutils import Vector

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
WORK_DIR = os.environ.get("ULTRAMAN_ART_WORK_DIR", os.path.join(BASE_DIR, "work"))
ORIG_DIR = os.path.join(WORK_DIR, "backup_orig_models")
TEX_DIR = os.path.join(WORK_DIR, "pbr_textures")
ZERO_FBX = os.path.join(WORK_DIR, "downloads/zero_pb/Ultraman Zero/Ultraman_Zero.fbx")
OUT_DIR = os.path.join(REPO_ROOT, "ui/public/models/ultraman")


def load_packed_image(filename: str, colorspace: str = "sRGB"):
    img = bpy.data.images.load(os.path.join(TEX_DIR, filename), check_existing=True)
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def setup_official_pbr_material(mat_name: str, hero_id: str, emission_strength: float = 1.05):
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out_n = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])

    t_col = nt.nodes.new("ShaderNodeTexImage")
    t_col.image = load_packed_image(f"{hero_id}_albedo.png", "sRGB")
    t_orm = nt.nodes.new("ShaderNodeTexImage")
    t_orm.image = load_packed_image(f"{hero_id}_orm.png", "Non-Color")
    t_nrm = nt.nodes.new("ShaderNodeTexImage")
    t_nrm.image = load_packed_image(f"{hero_id}_normal.png", "Non-Color")

    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.92

    nt.links.new(t_col.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(t_nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    em_path = os.path.join(TEX_DIR, f"{hero_id}_emissive.png")
    if os.path.exists(em_path):
        t_em = nt.nodes.new("ShaderNodeTexImage")
        t_em.image = load_packed_image(f"{hero_id}_emissive.png", "sRGB")
        nt.links.new(t_em.outputs["Color"], bsdf.inputs["Emission Color"])
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength

    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.24
    if "Coat Roughness" in bsdf.inputs:
        bsdf.inputs["Coat Roughness"].default_value = 0.22
    return mat


def rebuild_zero():
    print("正在构建官方正版高模赛罗 (zero.glb)...")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.fbx_import(filepath=ZERO_FBX)
    bpy.context.view_layer.update()

    # 清除全部导入动作并复位为完美左右对称 REST A-Pose
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    assert arm is not None, "赛罗 FBX 缺少 Armature"
    if arm.animation_data:
        arm.animation_data_clear()
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
        pb.scale = (1, 1, 1)

    # 删除悬空脱手冰斧武器（本体 Race_1201 头顶已自带完整标志性双头镖冰斧！）
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and ("wuqi" in obj.name.lower() or "icosphere" in obj.name.lower()):
            bpy.data.objects.remove(obj, do_unlink=True)

    body = next((o for o in bpy.data.objects if o.type == "MESH"), None)
    assert body is not None, "赛罗缺少主体 Mesh"

    # 统一缩放至 ~2.08m 标准人形尺度（原 FBX 单位为 cm，scale 放大 100 倍并让脚底贴 Z=0）
    arm.scale = (arm.scale.x * 100.0, arm.scale.y * 100.0, arm.scale.z * 100.0)
    bpy.context.view_layer.update()
    pts = [body.matrix_world @ v.co for v in body.data.vertices]
    min_z = min(p.z for p in pts)
    arm.location.z -= min_z
    bpy.context.view_layer.update()

    # 统一平滑着色并挂载 2K 影视级全通道 PBR 材质（命名 zero_suit_mat）
    body.data.polygons.foreach_set("use_smooth", [True] * len(body.data.polygons))
    mat_zero = setup_official_pbr_material("zero_suit_mat", "zero", emission_strength=1.10)
    body.data.materials.clear()
    body.data.materials.append(mat_zero)

    # 将 3ds Max Bip001 旁支 Twist 辅助骨的蒙皮权重无损合并进主串联骨，彻底杜绝动作变形时大臂/小臂/大腿脱节
    merge_map = {
        "Bip001 LUpArmTwist": "Bip001 L UpperArm",
        "Bip001 LUpArmTwist1": "Bip001 L UpperArm",
        "Bip001 RUpArmTwist": "Bip001 R UpperArm",
        "Bip001 RUpArmTwist1": "Bip001 R UpperArm",
        "Bip001 L ForeTwist": "Bip001 L Forearm",
        "Bip001 L ForeTwist1": "Bip001 L Forearm",
        "Bip001 R ForeTwist": "Bip001 R Forearm",
        "Bip001 R ForeTwist1": "Bip001 R Forearm",
        "Bip001 LThighTwist": "Bip001 L Thigh",
        "Bip001 LThighTwist1": "Bip001 L Thigh",
        "Bip001 RThighTwist": "Bip001 R Thigh",
        "Bip001 RThighTwist1": "Bip001 R Thigh",
    }
    for src_name, dst_name in merge_map.items():
        src_vg = body.vertex_groups.get(src_name)
        if not src_vg:
            continue
        dst_vg = body.vertex_groups.get(dst_name) or body.vertex_groups.new(name=dst_name)
        src_idx = src_vg.index
        for v in body.data.vertices:
            w = 0.0
            for g in v.groups:
                if g.group == src_idx:
                    w = g.weight
                    break
            if w > 0.0:
                dst_vg.add([v.index], w, "ADD")
        body.vertex_groups.remove(src_vg)

    bpy.ops.outliner.orphans_purge(do_recursive=True)
    out_glb = os.path.join(OUT_DIR, "zero.glb")
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=90,
        export_skins=True,
        export_animations=False,
    )
    print(f"✓ 官模赛罗已导出: {out_glb} ({os.path.getsize(out_glb) // 1024} KB)")


def rebuild_dyna_or_zeta(hero_id: str, mat_name: str, emission_strength: float):
    print(f"正在 2K 影视级重制 {hero_id.upper()} ({hero_id}.glb)...")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ORIG_DIR, f"{hero_id}.glb"))
    bpy.context.view_layer.update()

    # 清理冗余废网格 Icosphere
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and "icosphere" in obj.name.lower():
            bpy.data.objects.remove(obj, do_unlink=True)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    assert meshes, f"{hero_id} 缺少 Mesh"

    mat = setup_official_pbr_material(mat_name, hero_id, emission_strength=emission_strength)
    for m in meshes:
        m.data.polygons.foreach_set("use_smooth", [True] * len(m.data.polygons))
        m.data.materials.clear()
        m.data.materials.append(mat)

    bpy.ops.outliner.orphans_purge(do_recursive=True)
    out_glb = os.path.join(OUT_DIR, f"{hero_id}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format="GLB",
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=90,
        export_skins=True,
        export_animations=False,
    )
    print(f"✓ {hero_id.upper()} 已导出: {out_glb} ({os.path.getsize(out_glb) // 1024} KB)")


if __name__ == "__main__":
    rebuild_zero()
    rebuild_dyna_or_zeta("dyna", "dyna_suit_mat", emission_strength=1.02)
    rebuild_dyna_or_zeta("zeta", "zeta_suit_mat", emission_strength=1.08)
