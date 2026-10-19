/* Nastran card schema used by the create/modify editors. */
window.WebMeshNastranSchema = {
  "schemaVersion": 1,
  "tier": "Tier1",
  "meta": {
    "generator": "tools/generate_schema.py:ast_v1",
    "pyNastranSourceHash": "2f6db9c1a629d2ba74d8efe587762d95fdeb8f79f5d82a71ea3c0c4fcb5908a1",
    "pynastranRoot": "pyNastran/pyNastran",
    "scannedFiles": [
      "pyNastran/pyNastran/bdf/cards/__init__.py",
      "pyNastran/pyNastran/bdf/cards/aero/__init__.py",
      "pyNastran/pyNastran/bdf/cards/aero/aero.py",
      "pyNastran/pyNastran/bdf/cards/aero/dynamic_loads.py",
      "pyNastran/pyNastran/bdf/cards/aero/spline_utils.py",
      "pyNastran/pyNastran/bdf/cards/aero/static_loads.py",
      "pyNastran/pyNastran/bdf/cards/aero/utils.py",
      "pyNastran/pyNastran/bdf/cards/aero/wkk.py",
      "pyNastran/pyNastran/bdf/cards/aero/zona.py",
      "pyNastran/pyNastran/bdf/cards/axisymmetric/loads.py",
      "pyNastran/pyNastran/bdf/cards/base_card.py",
      "pyNastran/pyNastran/bdf/cards/bdf_sets.py",
      "pyNastran/pyNastran/bdf/cards/bdf_tables.py",
      "pyNastran/pyNastran/bdf/cards/bolt.py",
      "pyNastran/pyNastran/bdf/cards/collpase_card.py",
      "pyNastran/pyNastran/bdf/cards/constraints.py",
      "pyNastran/pyNastran/bdf/cards/contact.py",
      "pyNastran/pyNastran/bdf/cards/coordinate_systems.py",
      "pyNastran/pyNastran/bdf/cards/cyclic.py",
      "pyNastran/pyNastran/bdf/cards/deqatn.py",
      "pyNastran/pyNastran/bdf/cards/dmig.py",
      "pyNastran/pyNastran/bdf/cards/dynamic.py",
      "pyNastran/pyNastran/bdf/cards/elements/__init__.py",
      "pyNastran/pyNastran/bdf/cards/elements/acoustic.py",
      "pyNastran/pyNastran/bdf/cards/elements/axisymmetric_shells.py",
      "pyNastran/pyNastran/bdf/cards/elements/bars.py",
      "pyNastran/pyNastran/bdf/cards/elements/beam.py",
      "pyNastran/pyNastran/bdf/cards/elements/beam_connectivity.py",
      "pyNastran/pyNastran/bdf/cards/elements/beam_line_connectivity.py",
      "pyNastran/pyNastran/bdf/cards/elements/bush.py",
      "pyNastran/pyNastran/bdf/cards/elements/damper.py",
      "pyNastran/pyNastran/bdf/cards/elements/elements.py",
      "pyNastran/pyNastran/bdf/cards/elements/mass.py",
      "pyNastran/pyNastran/bdf/cards/elements/optimization_utils.py",
      "pyNastran/pyNastran/bdf/cards/elements/plot.py",
      "pyNastran/pyNastran/bdf/cards/elements/rigid.py",
      "pyNastran/pyNastran/bdf/cards/elements/rods.py",
      "pyNastran/pyNastran/bdf/cards/elements/shell.py",
      "pyNastran/pyNastran/bdf/cards/elements/shell_laminate_plot.py",
      "pyNastran/pyNastran/bdf/cards/elements/solid.py",
      "pyNastran/pyNastran/bdf/cards/elements/springs.py",
      "pyNastran/pyNastran/bdf/cards/expand_card.py",
      "pyNastran/pyNastran/bdf/cards/glue.py",
      "pyNastran/pyNastran/bdf/cards/loads/__init__.py",
      "pyNastran/pyNastran/bdf/cards/loads/dloads.py",
      "pyNastran/pyNastran/bdf/cards/loads/loads.py",
      "pyNastran/pyNastran/bdf/cards/loads/random_loads.py",
      "pyNastran/pyNastran/bdf/cards/loads/static_loads.py",
      "pyNastran/pyNastran/bdf/cards/material_deps.py",
      "pyNastran/pyNastran/bdf/cards/materials.py",
      "pyNastran/pyNastran/bdf/cards/methods.py",
      "pyNastran/pyNastran/bdf/cards/nodes.py",
      "pyNastran/pyNastran/bdf/cards/optimization.py",
      "pyNastran/pyNastran/bdf/cards/optimization_nx.py",
      "pyNastran/pyNastran/bdf/cards/parametric/__init__.py",
      "pyNastran/pyNastran/bdf/cards/parametric/geometry.py",
      "pyNastran/pyNastran/bdf/cards/params.py",
      "pyNastran/pyNastran/bdf/cards/properties/__init__.py",
      "pyNastran/pyNastran/bdf/cards/properties/bars.py",
      "pyNastran/pyNastran/bdf/cards/properties/beam.py",
      "pyNastran/pyNastran/bdf/cards/properties/bush.py",
      "pyNastran/pyNastran/bdf/cards/properties/damper.py",
      "pyNastran/pyNastran/bdf/cards/properties/mass.py",
      "pyNastran/pyNastran/bdf/cards/properties/properties.py",
      "pyNastran/pyNastran/bdf/cards/properties/rods.py",
      "pyNastran/pyNastran/bdf/cards/properties/shell.py",
      "pyNastran/pyNastran/bdf/cards/properties/solid.py",
      "pyNastran/pyNastran/bdf/cards/properties/springs.py",
      "pyNastran/pyNastran/bdf/cards/superelements.py",
      "pyNastran/pyNastran/bdf/cards/test/__init__.py",
      "pyNastran/pyNastran/bdf/cards/test/all_tests.py",
      "pyNastran/pyNastran/bdf/cards/test/test_acoustic.py",
      "pyNastran/pyNastran/bdf/cards/test/test_aero.py",
      "pyNastran/pyNastran/bdf/cards/test/test_axisymmetric.py",
      "pyNastran/pyNastran/bdf/cards/test/test_bars.py",
      "pyNastran/pyNastran/bdf/cards/test/test_base_card.py",
      "pyNastran/pyNastran/bdf/cards/test/test_beams.py",
      "pyNastran/pyNastran/bdf/cards/test/test_bolt_nx.py",
      "pyNastran/pyNastran/bdf/cards/test/test_constraints.py",
      "pyNastran/pyNastran/bdf/cards/test/test_contact.py",
      "pyNastran/pyNastran/bdf/cards/test/test_coords.py",
      "pyNastran/pyNastran/bdf/cards/test/test_cyclic.py",
      "pyNastran/pyNastran/bdf/cards/test/test_dampers.py",
      "pyNastran/pyNastran/bdf/cards/test/test_deqatn.py",
      "pyNastran/pyNastran/bdf/cards/test/test_dmig.py",
      "pyNastran/pyNastran/bdf/cards/test/test_dynamic.py",
      "pyNastran/pyNastran/bdf/cards/test/test_elements.py",
      "pyNastran/pyNastran/bdf/cards/test/test_loads.py",
      "pyNastran/pyNastran/bdf/cards/test/test_mass_elements.py",
      "pyNastran/pyNastran/bdf/cards/test/test_materials.py",
      "pyNastran/pyNastran/bdf/cards/test/test_methods.py",
      "pyNastran/pyNastran/bdf/cards/test/test_nodes.py",
      "pyNastran/pyNastran/bdf/cards/test/test_nsm.py",
      "pyNastran/pyNastran/bdf/cards/test/test_optimization.py",
      "pyNastran/pyNastran/bdf/cards/test/test_parametric.py",
      "pyNastran/pyNastran/bdf/cards/test/test_params.py",
      "pyNastran/pyNastran/bdf/cards/test/test_rigid.py",
      "pyNastran/pyNastran/bdf/cards/test/test_rods.py",
      "pyNastran/pyNastran/bdf/cards/test/test_sets.py",
      "pyNastran/pyNastran/bdf/cards/test/test_shells.py",
      "pyNastran/pyNastran/bdf/cards/test/test_solids.py",
      "pyNastran/pyNastran/bdf/cards/test/test_springs.py",
      "pyNastran/pyNastran/bdf/cards/test/test_superelements.py",
      "pyNastran/pyNastran/bdf/cards/test/test_tables.py",
      "pyNastran/pyNastran/bdf/cards/test/test_thermal.py",
      "pyNastran/pyNastran/bdf/cards/test/utils.py",
      "pyNastran/pyNastran/bdf/cards/thermal/__init__.py",
      "pyNastran/pyNastran/bdf/cards/thermal/loads.py",
      "pyNastran/pyNastran/bdf/cards/thermal/radiation.py",
      "pyNastran/pyNastran/bdf/cards/thermal/thermal.py",
      "pyNastran/pyNastran/bdf/cards/utils.py",
      "pyNastran/pyNastran/bdf/bdf_interface/__init__.py",
      "pyNastran/pyNastran/bdf/bdf_interface/add_card.py",
      "pyNastran/pyNastran/bdf/bdf_interface/add_methods.py",
      "pyNastran/pyNastran/bdf/bdf_interface/assign_type.py",
      "pyNastran/pyNastran/bdf/bdf_interface/assign_type_force.py",
      "pyNastran/pyNastran/bdf/bdf_interface/attributes.py",
      "pyNastran/pyNastran/bdf/bdf_interface/bdf_card.py",
      "pyNastran/pyNastran/bdf/bdf_interface/card_groups.py",
      "pyNastran/pyNastran/bdf/bdf_interface/case_control_cards.py",
      "pyNastran/pyNastran/bdf/bdf_interface/compare_card_content.py",
      "pyNastran/pyNastran/bdf/bdf_interface/cross_reference.py",
      "pyNastran/pyNastran/bdf/bdf_interface/cross_reference_obj.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/__init__.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/dedemap.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/dmap.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/mass.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/matrices.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/set_operations.py",
      "pyNastran/pyNastran/bdf/bdf_interface/dev/test_mass.py",
      "pyNastran/pyNastran/bdf/bdf_interface/encoding.py",
      "pyNastran/pyNastran/bdf/bdf_interface/get_card.py",
      "pyNastran/pyNastran/bdf/bdf_interface/get_methods.py",
      "pyNastran/pyNastran/bdf/bdf_interface/hdf5_exporter.py",
      "pyNastran/pyNastran/bdf/bdf_interface/hdf5_loader.py",
      "pyNastran/pyNastran/bdf/bdf_interface/include_file.py",
      "pyNastran/pyNastran/bdf/bdf_interface/internal_get.py",
      "pyNastran/pyNastran/bdf/bdf_interface/model_group.py",
      "pyNastran/pyNastran/bdf/bdf_interface/pybdf.py",
      "pyNastran/pyNastran/bdf/bdf_interface/replication.py",
      "pyNastran/pyNastran/bdf/bdf_interface/safe_cross_reference.py",
      "pyNastran/pyNastran/bdf/bdf_interface/stats.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/__init__.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/cards.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_check.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_int.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_str.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/h5py_interface.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/int_str_cards.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/matrix.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/sets.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/subcase_base.py",
      "pyNastran/pyNastran/bdf/bdf_interface/subcase/utils.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/__init__.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_assign_type.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_bdf_interface.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_case_control_deck.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_dev_utils.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_executive.py",
      "pyNastran/pyNastran/bdf/bdf_interface/test/test_pybdf.py",
      "pyNastran/pyNastran/bdf/bdf_interface/uncross_reference.py",
      "pyNastran/pyNastran/bdf/bdf_interface/utils.py",
      "pyNastran/pyNastran/bdf/bdf_interface/verify_validate.py",
      "pyNastran/pyNastran/bdf/bdf_interface/write_mesh.py",
      "pyNastran/pyNastran/bdf/bdf_interface/write_mesh_file.py",
      "pyNastran/pyNastran/bdf/bdf_interface/write_mesh_utils.py"
    ],
    "wantedCardCount": 32,
    "extractedCardCount": 32,
    "missingCards": [],
    "qrgSourceCards": [
      "CBAR",
      "CBEAM",
      "CBUSH",
      "CHEXA",
      "CONM2",
      "CORD1C",
      "CORD1R",
      "CORD2C",
      "CORD2R",
      "CORD2S",
      "CQUAD4",
      "CROD",
      "CTETRA",
      "CTRIA3",
      "FORCE",
      "GRID",
      "LOAD",
      "MAT1",
      "MOMENT",
      "PBAR",
      "PBEAM",
      "PBUSH",
      "PCOMP",
      "PLOAD2",
      "PLOAD4",
      "PROD",
      "PSHELL",
      "PSOLID",
      "RBE2",
      "RBE3",
      "SPC",
      "SPC1"
    ],
    "tiersFile": "docs/NastranCardTiers.txt",
    "maxTier": 1,
    "qrgFieldMap": "References/New References/qrg_field_map.json",
    "structuralDirectives": [
      "BEGIN BULK",
      "CEND",
      "DISPLACEMENT",
      "ENDDATA",
      "INCLUDE",
      "SOL",
      "STRESS",
      "SUBCASE"
    ]
  },
  "cards": {
    "CBAR": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "pid",
          "type": "int",
          "required": false,
          "defaultFrom": "pid_default"
        },
        {
          "index": 3,
          "name": "ga",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "gb",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "x1",
          "type": "number",
          "required": false
        },
        {
          "index": 6,
          "name": "x2",
          "type": "float",
          "required": false
        },
        {
          "index": 7,
          "name": "x3",
          "type": "float",
          "required": false
        },
        {
          "index": 8,
          "name": "offt",
          "type": "string",
          "required": false,
          "default": "GGG"
        },
        {
          "index": 9,
          "name": "pa",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "pb",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "w1a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "w2a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "w3a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "w1b",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 15,
          "name": "w2b",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "w3b",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "CBEAM": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "pid",
          "type": "int",
          "required": false,
          "defaultFrom": "pid_default"
        },
        {
          "index": 3,
          "name": "ga",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "gb",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "x1",
          "type": "number",
          "required": false
        },
        {
          "index": 6,
          "name": "x2",
          "type": "float",
          "required": false
        },
        {
          "index": 7,
          "name": "x3",
          "type": "float",
          "required": false
        },
        {
          "index": 8,
          "name": "offt",
          "type": "string",
          "required": false,
          "default": "GGG"
        },
        {
          "index": 9,
          "name": "pa",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "pb",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "w1a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "w2a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "w3a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "w1b",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 15,
          "name": "w2b",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "w3b",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 17,
          "name": "sa",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 18,
          "name": "sb",
          "type": "int",
          "required": false,
          "default": 0
        }
      ]
    },
    "CBUSH": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "pid",
          "type": "int",
          "required": false,
          "defaultFrom": "pid_default"
        },
        {
          "index": 3,
          "name": "ga",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "gb",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "x1_g0",
          "type": "number",
          "required": false
        },
        {
          "index": 6,
          "name": "x2",
          "type": "float",
          "required": false
        },
        {
          "index": 7,
          "name": "x3",
          "type": "float",
          "required": false
        },
        {
          "index": 8,
          "name": "cid",
          "type": "int",
          "required": false
        },
        {
          "index": 9,
          "name": "s",
          "type": "float",
          "required": false,
          "default": 0.5
        },
        {
          "index": 10,
          "name": "ocid",
          "type": "int",
          "required": false,
          "default": -1
        },
        {
          "index": 11,
          "name": "s1",
          "type": "float",
          "required": false
        },
        {
          "index": 12,
          "name": "s2",
          "type": "float",
          "required": false
        },
        {
          "index": 13,
          "name": "s3",
          "type": "float",
          "required": false
        }
      ]
    },
    "CHEXA": {
      "fields": [
        {
          "index": 1,
          "name": "EID",
          "type": "string",
          "required": false
        },
        {
          "index": 2,
          "name": "PID",
          "type": "string",
          "required": false
        },
        {
          "index": 3,
          "name": "G1",
          "type": "string",
          "required": false
        },
        {
          "index": 4,
          "name": "G2",
          "type": "string",
          "required": false
        },
        {
          "index": 5,
          "name": "G3",
          "type": "string",
          "required": false
        },
        {
          "index": 6,
          "name": "G4",
          "type": "string",
          "required": false
        },
        {
          "index": 7,
          "name": "G5",
          "type": "string",
          "required": false
        },
        {
          "index": 8,
          "name": "G6",
          "type": "string",
          "required": false
        },
        {
          "index": 9,
          "name": "G7",
          "type": "string",
          "required": false
        },
        {
          "index": 10,
          "name": "G8",
          "type": "string",
          "required": false
        },
        {
          "index": 11,
          "name": "G9",
          "type": "string",
          "required": false
        },
        {
          "index": 12,
          "name": "G10",
          "type": "string",
          "required": false
        },
        {
          "index": 13,
          "name": "G11",
          "type": "string",
          "required": false
        },
        {
          "index": 14,
          "name": "G12",
          "type": "string",
          "required": false
        },
        {
          "index": 15,
          "name": "G13",
          "type": "string",
          "required": false
        },
        {
          "index": 16,
          "name": "G14",
          "type": "string",
          "required": false
        },
        {
          "index": 17,
          "name": "G15",
          "type": "string",
          "required": false
        },
        {
          "index": 18,
          "name": "G16",
          "type": "string",
          "required": false
        },
        {
          "index": 19,
          "name": "G17",
          "type": "string",
          "required": false
        },
        {
          "index": 20,
          "name": "G18",
          "type": "string",
          "required": false
        },
        {
          "index": 21,
          "name": "G19",
          "type": "string",
          "required": false
        },
        {
          "index": 22,
          "name": "G20",
          "type": "string",
          "required": false
        }
      ]
    },
    "CONM2": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "g",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "cid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "m",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "x1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "x2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "x3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "I11",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "I21",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "I22",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "I31",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "I32",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "I33",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "CORD1C": {
      "fields": [
        {
          "index": 1,
          "name": "cid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "g1",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "g2",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "g3",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "cidb",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "g1b",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "g2b",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "g3b",
          "type": "int",
          "required": false
        }
      ]
    },
    "CORD1R": {
      "fields": [
        {
          "index": 1,
          "name": "cid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "g1",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "g2",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "g3",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "cidb",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "g1b",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "g2b",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "g3b",
          "type": "int",
          "required": false
        }
      ]
    },
    "CORD2C": {
      "fields": [
        {
          "index": 1,
          "name": "cid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "rid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 3,
          "name": "e1x",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "e1y",
          "type": "float",
          "required": true
        },
        {
          "index": 5,
          "name": "e1z",
          "type": "float",
          "required": true
        },
        {
          "index": 6,
          "name": "e2x",
          "type": "float",
          "required": true
        },
        {
          "index": 7,
          "name": "e2y",
          "type": "float",
          "required": true
        },
        {
          "index": 8,
          "name": "e2z",
          "type": "float",
          "required": true
        },
        {
          "index": 9,
          "name": "e3x",
          "type": "float",
          "required": true
        },
        {
          "index": 10,
          "name": "e3y",
          "type": "float",
          "required": true
        },
        {
          "index": 11,
          "name": "e3z",
          "type": "float",
          "required": true
        }
      ]
    },
    "CORD2R": {
      "fields": [
        {
          "index": 1,
          "name": "cid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "rid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 3,
          "name": "e1x",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "e1y",
          "type": "float",
          "required": true
        },
        {
          "index": 5,
          "name": "e1z",
          "type": "float",
          "required": true
        },
        {
          "index": 6,
          "name": "e2x",
          "type": "float",
          "required": true
        },
        {
          "index": 7,
          "name": "e2y",
          "type": "float",
          "required": true
        },
        {
          "index": 8,
          "name": "e2z",
          "type": "float",
          "required": true
        },
        {
          "index": 9,
          "name": "e3x",
          "type": "float",
          "required": true
        },
        {
          "index": 10,
          "name": "e3y",
          "type": "float",
          "required": true
        },
        {
          "index": 11,
          "name": "e3z",
          "type": "float",
          "required": true
        }
      ]
    },
    "CORD2S": {
      "fields": [
        {
          "index": 1,
          "name": "cid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "rid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 3,
          "name": "e1x",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "e1y",
          "type": "float",
          "required": true
        },
        {
          "index": 5,
          "name": "e1z",
          "type": "float",
          "required": true
        },
        {
          "index": 6,
          "name": "e2x",
          "type": "float",
          "required": true
        },
        {
          "index": 7,
          "name": "e2y",
          "type": "float",
          "required": true
        },
        {
          "index": 8,
          "name": "e2z",
          "type": "float",
          "required": true
        },
        {
          "index": 9,
          "name": "e3x",
          "type": "float",
          "required": true
        },
        {
          "index": 10,
          "name": "e3y",
          "type": "float",
          "required": true
        },
        {
          "index": 11,
          "name": "e3z",
          "type": "float",
          "required": true
        }
      ]
    },
    "CQUAD4": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "pid",
          "type": "int",
          "required": false,
          "defaultFrom": "eid"
        },
        {
          "index": 3,
          "name": "n1",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "n2",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "n3",
          "type": "int",
          "required": true
        },
        {
          "index": 6,
          "name": "n4",
          "type": "int",
          "required": true
        },
        {
          "index": 7,
          "name": "theta_mcid",
          "type": "number",
          "required": false,
          "default": 0
        },
        {
          "index": 8,
          "name": "zoffset",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "blank",
          "type": "blank",
          "required": false
        },
        {
          "index": 10,
          "name": "tflag",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "T1",
          "type": "float",
          "required": false
        },
        {
          "index": 12,
          "name": "T2",
          "type": "float",
          "required": false
        },
        {
          "index": 13,
          "name": "T3",
          "type": "float",
          "required": false
        },
        {
          "index": 14,
          "name": "T4",
          "type": "float",
          "required": false
        }
      ]
    },
    "CROD": {
      "fields": [
        {
          "index": 1,
          "name": "EID",
          "type": "string",
          "required": false
        },
        {
          "index": 2,
          "name": "PID",
          "type": "string",
          "required": false
        },
        {
          "index": 3,
          "name": "G1",
          "type": "string",
          "required": false
        },
        {
          "index": 4,
          "name": "G2",
          "type": "string",
          "required": false
        }
      ]
    },
    "CTETRA": {
      "fields": [
        {
          "index": 1,
          "name": "EID",
          "type": "string",
          "required": false
        },
        {
          "index": 2,
          "name": "PID",
          "type": "string",
          "required": false
        },
        {
          "index": 3,
          "name": "G1",
          "type": "string",
          "required": false
        },
        {
          "index": 4,
          "name": "G2",
          "type": "string",
          "required": false
        },
        {
          "index": 5,
          "name": "G3",
          "type": "string",
          "required": false
        },
        {
          "index": 6,
          "name": "G4",
          "type": "string",
          "required": false
        },
        {
          "index": 7,
          "name": "G5",
          "type": "string",
          "required": false
        },
        {
          "index": 8,
          "name": "G6",
          "type": "string",
          "required": false
        },
        {
          "index": 9,
          "name": "G7",
          "type": "string",
          "required": false
        },
        {
          "index": 10,
          "name": "G8",
          "type": "string",
          "required": false
        },
        {
          "index": 11,
          "name": "G9",
          "type": "string",
          "required": false
        },
        {
          "index": 12,
          "name": "G10",
          "type": "string",
          "required": false
        }
      ]
    },
    "CTRIA3": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "pid",
          "type": "int",
          "required": false,
          "defaultFrom": "eid"
        },
        {
          "index": 3,
          "name": "n1",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "n2",
          "type": "int",
          "required": true
        },
        {
          "index": 5,
          "name": "n3",
          "type": "int",
          "required": true
        },
        {
          "index": 6,
          "name": "theta_mcid",
          "type": "number",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "zoffset",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 8,
          "name": "blank",
          "type": "blank",
          "required": false
        },
        {
          "index": 9,
          "name": "blank",
          "type": "blank",
          "required": false
        },
        {
          "index": 10,
          "name": "tflag",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "T1",
          "type": "float",
          "required": false
        },
        {
          "index": 12,
          "name": "T2",
          "type": "float",
          "required": false
        },
        {
          "index": 13,
          "name": "T3",
          "type": "float",
          "required": false
        }
      ]
    },
    "FORCE": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "g",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "cid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "f",
          "type": "float",
          "required": true
        },
        {
          "index": 5,
          "name": "n1",
          "type": "float",
          "required": true
        },
        {
          "index": 6,
          "name": "n2",
          "type": "float",
          "required": true
        },
        {
          "index": 7,
          "name": "n3",
          "type": "float",
          "required": true
        }
      ]
    },
    "GRID": {
      "fields": [
        {
          "index": 1,
          "name": "nid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "cp",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 3,
          "name": "x1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "x2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "x3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "cd",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "ps",
          "type": "string",
          "required": false,
          "default": ""
        },
        {
          "index": 8,
          "name": "seid",
          "type": "int",
          "required": false,
          "default": 0
        }
      ]
    },
    "LOAD": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "scale",
          "type": "float",
          "required": true
        },
        {
          "index": 3,
          "name": "s1",
          "type": "float",
          "required": false
        },
        {
          "index": 4,
          "name": "l1",
          "type": "int",
          "required": false
        },
        {
          "index": 5,
          "name": "s2",
          "type": "float",
          "required": false
        },
        {
          "index": 6,
          "name": "l2",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "s3",
          "type": "float",
          "required": false
        },
        {
          "index": 8,
          "name": "l3",
          "type": "int",
          "required": false
        },
        {
          "index": 9,
          "name": "s4",
          "type": "float",
          "required": false
        },
        {
          "index": 10,
          "name": "l4",
          "type": "int",
          "required": false
        }
      ]
    },
    "MAT1": {
      "fields": [
        {
          "index": 1,
          "name": "mid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "E",
          "type": "float",
          "required": false
        },
        {
          "index": 3,
          "name": "G",
          "type": "float",
          "required": false
        },
        {
          "index": 4,
          "name": "nu",
          "type": "float",
          "required": false
        },
        {
          "index": 5,
          "name": "rho",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "tref",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 8,
          "name": "ge",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "st",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "sc",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "ss",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "mcsid",
          "type": "int",
          "required": false
        }
      ]
    },
    "MOMENT": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "g",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "cid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "m",
          "type": "float",
          "required": true
        },
        {
          "index": 5,
          "name": "n1",
          "type": "float",
          "required": true
        },
        {
          "index": 6,
          "name": "n2",
          "type": "float",
          "required": true
        },
        {
          "index": 7,
          "name": "n3",
          "type": "float",
          "required": true
        }
      ]
    },
    "PBAR": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "mid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "A",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "I1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "I2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "J",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "nsm",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "C1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "C2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "D1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "D2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "E1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "E2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 15,
          "name": "F1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "F2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 17,
          "name": "K1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 18,
          "name": "K2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 19,
          "name": "I12",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "PBEAM": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "mid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "a_a",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "i1_a",
          "type": "float",
          "required": false
        },
        {
          "index": 5,
          "name": "i2_a",
          "type": "float",
          "required": false
        },
        {
          "index": 6,
          "name": "i12_a",
          "type": "float",
          "required": false
        },
        {
          "index": 7,
          "name": "j_a",
          "type": "float",
          "required": false
        },
        {
          "index": 8,
          "name": "nsm_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "c1_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "c2_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 11,
          "name": "d1_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "d2_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "e1_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "e2_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 15,
          "name": "f1_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "f2_a",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 17,
          "name": "so",
          "type": "string",
          "required": false
        },
        {
          "index": 18,
          "name": "x_xb",
          "type": "float",
          "required": false
        },
        {
          "index": 19,
          "name": "a",
          "type": "float",
          "required": false
        },
        {
          "index": 20,
          "name": "i1",
          "type": "float",
          "required": false
        },
        {
          "index": 21,
          "name": "i2",
          "type": "float",
          "required": false
        },
        {
          "index": 22,
          "name": "i12",
          "type": "float",
          "required": false
        },
        {
          "index": 23,
          "name": "j",
          "type": "float",
          "required": false
        },
        {
          "index": 24,
          "name": "nsm",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 25,
          "name": "c1",
          "type": "float",
          "required": false
        },
        {
          "index": 26,
          "name": "c2",
          "type": "float",
          "required": false
        },
        {
          "index": 27,
          "name": "d1",
          "type": "float",
          "required": false
        },
        {
          "index": 28,
          "name": "d2",
          "type": "float",
          "required": false
        },
        {
          "index": 29,
          "name": "e1",
          "type": "float",
          "required": false
        },
        {
          "index": 30,
          "name": "e2",
          "type": "float",
          "required": false
        },
        {
          "index": 31,
          "name": "f1",
          "type": "float",
          "required": false
        },
        {
          "index": 32,
          "name": "f2",
          "type": "float",
          "required": false
        },
        {
          "index": 33,
          "name": "k1",
          "type": "float",
          "required": false
        },
        {
          "index": 34,
          "name": "k2",
          "type": "float",
          "required": false
        },
        {
          "index": 35,
          "name": "s1",
          "type": "float",
          "required": false
        },
        {
          "index": 36,
          "name": "s2",
          "type": "float",
          "required": false
        },
        {
          "index": 37,
          "name": "nsi_a",
          "type": "float",
          "required": false
        },
        {
          "index": 38,
          "name": "nsi_b",
          "type": "float",
          "required": false
        },
        {
          "index": 39,
          "name": "cw_a",
          "type": "float",
          "required": false
        },
        {
          "index": 40,
          "name": "cw_b",
          "type": "float",
          "required": false
        },
        {
          "index": 41,
          "name": "m1_a",
          "type": "float",
          "required": false
        },
        {
          "index": 42,
          "name": "m2_a",
          "type": "float",
          "required": false
        },
        {
          "index": 43,
          "name": "m1_b",
          "type": "float",
          "required": false
        },
        {
          "index": 44,
          "name": "m2_b",
          "type": "float",
          "required": false
        },
        {
          "index": 45,
          "name": "n1_a",
          "type": "float",
          "required": false
        },
        {
          "index": 46,
          "name": "n2_a",
          "type": "float",
          "required": false
        },
        {
          "index": 47,
          "name": "n1_b",
          "type": "float",
          "required": false
        },
        {
          "index": 48,
          "name": "n2_b",
          "type": "float",
          "required": false
        }
      ]
    },
    "PBUSH": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "K",
          "type": "string",
          "required": false
        },
        {
          "index": 3,
          "name": "K1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "K2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "K3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "K4",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "K5",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 8,
          "name": "K6",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "B",
          "type": "string",
          "required": false
        },
        {
          "index": 11,
          "name": "B1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "B2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 13,
          "name": "B3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 14,
          "name": "B4",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 15,
          "name": "B5",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "B6",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 18,
          "name": "GE",
          "type": "string",
          "required": false
        },
        {
          "index": 19,
          "name": "GE1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 20,
          "name": "GE2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 21,
          "name": "GE3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 22,
          "name": "GE4",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 23,
          "name": "GE5",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 24,
          "name": "GE6",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 26,
          "name": "RCV",
          "type": "string",
          "required": false
        },
        {
          "index": 27,
          "name": "SA",
          "type": "float",
          "required": false,
          "default": 1
        },
        {
          "index": 28,
          "name": "ST",
          "type": "float",
          "required": false,
          "default": 1
        },
        {
          "index": 29,
          "name": "EA",
          "type": "float",
          "required": false,
          "default": 1
        },
        {
          "index": 30,
          "name": "ET",
          "type": "float",
          "required": false,
          "default": 1
        }
      ]
    },
    "PCOMP": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "z0",
          "type": "float",
          "required": false
        },
        {
          "index": 3,
          "name": "nsm",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "sb",
          "type": "float",
          "required": false
        },
        {
          "index": 5,
          "name": "ft",
          "type": "string",
          "required": false
        },
        {
          "index": 6,
          "name": "tref",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 7,
          "name": "ge",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 8,
          "name": "lam",
          "type": "string",
          "required": false
        },
        {
          "index": 9,
          "name": "mid1",
          "type": "int",
          "required": true
        },
        {
          "index": 10,
          "name": "t1",
          "type": "float",
          "required": true
        },
        {
          "index": 11,
          "name": "theta1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 12,
          "name": "sout1",
          "type": "string",
          "required": false,
          "default": "NO"
        },
        {
          "index": 13,
          "name": "mid2",
          "type": "int",
          "required": false
        },
        {
          "index": 14,
          "name": "t2",
          "type": "float",
          "required": false
        },
        {
          "index": 15,
          "name": "theta2",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 16,
          "name": "sout2",
          "type": "string",
          "required": false,
          "default": "NO"
        },
        {
          "index": 17,
          "name": "mid3",
          "type": "int",
          "required": false
        },
        {
          "index": 18,
          "name": "t3",
          "type": "float",
          "required": false
        },
        {
          "index": 19,
          "name": "theta3",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 20,
          "name": "sout3",
          "type": "string",
          "required": false,
          "default": "NO"
        }
      ]
    },
    "PLOAD2": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "p",
          "type": "float",
          "required": true
        },
        {
          "index": 3,
          "name": "eid1",
          "type": "int",
          "required": false
        },
        {
          "index": 4,
          "name": "eid2",
          "type": "int",
          "required": false
        },
        {
          "index": 5,
          "name": "eid3",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "eid4",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "eid5",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "eid6",
          "type": "int",
          "required": false
        }
      ]
    },
    "PLOAD4": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "p1",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "p2",
          "type": "float",
          "required": false
        },
        {
          "index": 5,
          "name": "p3",
          "type": "float",
          "required": false
        },
        {
          "index": 6,
          "name": "p4",
          "type": "float",
          "required": false
        },
        {
          "index": 7,
          "name": "g1",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "g34",
          "type": "int",
          "required": false
        },
        {
          "index": 9,
          "name": "cid",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 10,
          "name": "n1",
          "type": "float",
          "required": false
        },
        {
          "index": 11,
          "name": "n2",
          "type": "float",
          "required": false
        },
        {
          "index": 12,
          "name": "n3",
          "type": "float",
          "required": false
        }
      ]
    },
    "PROD": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "mid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "A",
          "type": "float",
          "required": true
        },
        {
          "index": 4,
          "name": "j",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "c",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 6,
          "name": "nsm",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "PSHELL": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "mid1",
          "type": "int",
          "required": false
        },
        {
          "index": 3,
          "name": "t",
          "type": "float",
          "required": false
        },
        {
          "index": 4,
          "name": "mid2",
          "type": "int",
          "required": false
        },
        {
          "index": 5,
          "name": "i12t3",
          "type": "float",
          "required": false,
          "default": 1
        },
        {
          "index": 6,
          "name": "mid3",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "tst",
          "type": "float",
          "required": false,
          "default": 0.833333
        },
        {
          "index": 8,
          "name": "nsm",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 9,
          "name": "z1",
          "type": "float",
          "required": false
        },
        {
          "index": 10,
          "name": "z2",
          "type": "float",
          "required": false,
          "defaultFrom": "t_over_2"
        },
        {
          "index": 11,
          "name": "mid4",
          "type": "int",
          "required": false
        }
      ]
    },
    "PSOLID": {
      "fields": [
        {
          "index": 1,
          "name": "pid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "mid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "cordm",
          "type": "int",
          "required": false,
          "default": 0
        },
        {
          "index": 4,
          "name": "integ",
          "type": "string",
          "required": false
        },
        {
          "index": 5,
          "name": "stress",
          "type": "string",
          "required": false,
          "default": "GRID"
        },
        {
          "index": 6,
          "name": "isop",
          "type": "string",
          "required": false
        },
        {
          "index": 7,
          "name": "fctn",
          "type": "string",
          "required": false,
          "default": "SMECH"
        }
      ]
    },
    "RBE2": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "gn",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "cm",
          "type": "string",
          "required": true
        },
        {
          "index": 4,
          "name": "gm1",
          "type": "int",
          "required": false
        },
        {
          "index": 5,
          "name": "gm2",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "gm3",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "gm4",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "gm5",
          "type": "int",
          "required": false
        },
        {
          "index": 9,
          "name": "gm6",
          "type": "int",
          "required": false
        },
        {
          "index": 10,
          "name": "gm7",
          "type": "int",
          "required": false
        },
        {
          "index": 11,
          "name": "gm8",
          "type": "int",
          "required": false
        },
        {
          "index": 13,
          "name": "alpha",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "RBE3": {
      "fields": [
        {
          "index": 1,
          "name": "eid",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "refgrid",
          "type": "int",
          "required": true
        },
        {
          "index": 4,
          "name": "refc",
          "type": "string",
          "required": true
        },
        {
          "index": 5,
          "name": "wt1",
          "type": "float",
          "required": false
        },
        {
          "index": 6,
          "name": "c1",
          "type": "string",
          "required": false
        },
        {
          "index": 7,
          "name": "g1_1",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "g1_2",
          "type": "int",
          "required": false
        },
        {
          "index": 10,
          "name": "wt2",
          "type": "float",
          "required": false
        },
        {
          "index": 11,
          "name": "c2",
          "type": "string",
          "required": false
        },
        {
          "index": 12,
          "name": "g2_1",
          "type": "int",
          "required": false
        },
        {
          "index": 13,
          "name": "g2_2",
          "type": "int",
          "required": false
        },
        {
          "index": 15,
          "name": "wt3",
          "type": "float",
          "required": false
        },
        {
          "index": 16,
          "name": "c3",
          "type": "string",
          "required": false
        },
        {
          "index": 17,
          "name": "g3_1",
          "type": "int",
          "required": false
        },
        {
          "index": 18,
          "name": "g3_2",
          "type": "int",
          "required": false
        },
        {
          "index": 20,
          "name": "wt4",
          "type": "float",
          "required": false
        },
        {
          "index": 21,
          "name": "c4",
          "type": "string",
          "required": false
        },
        {
          "index": 22,
          "name": "g4_1",
          "type": "int",
          "required": false
        },
        {
          "index": 23,
          "name": "g4_2",
          "type": "int",
          "required": false
        },
        {
          "index": 25,
          "name": "um",
          "type": "string",
          "required": false
        },
        {
          "index": 26,
          "name": "gm1",
          "type": "int",
          "required": false
        },
        {
          "index": 27,
          "name": "cm1",
          "type": "string",
          "required": false
        },
        {
          "index": 28,
          "name": "gm2",
          "type": "int",
          "required": false
        },
        {
          "index": 29,
          "name": "cm2",
          "type": "string",
          "required": false
        },
        {
          "index": 30,
          "name": "gm3",
          "type": "int",
          "required": false
        },
        {
          "index": 31,
          "name": "cm3",
          "type": "string",
          "required": false
        },
        {
          "index": 34,
          "name": "gm4",
          "type": "int",
          "required": false
        },
        {
          "index": 35,
          "name": "cm4",
          "type": "string",
          "required": false
        },
        {
          "index": 36,
          "name": "gm5",
          "type": "int",
          "required": false
        },
        {
          "index": 37,
          "name": "cm5",
          "type": "string",
          "required": false
        },
        {
          "index": 41,
          "name": "alpha_marker",
          "type": "string",
          "required": false
        },
        {
          "index": 42,
          "name": "alpha",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "SPC": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "G1",
          "type": "int",
          "required": true
        },
        {
          "index": 3,
          "name": "C1",
          "type": "string",
          "required": false,
          "default": "0"
        },
        {
          "index": 4,
          "name": "D1",
          "type": "float",
          "required": false,
          "default": 0
        },
        {
          "index": 5,
          "name": "G2",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "C2",
          "type": "string",
          "required": false,
          "default": "0"
        },
        {
          "index": 7,
          "name": "D2",
          "type": "float",
          "required": false,
          "default": 0
        }
      ]
    },
    "SPC1": {
      "fields": [
        {
          "index": 1,
          "name": "sid",
          "type": "int",
          "required": true
        },
        {
          "index": 2,
          "name": "components",
          "type": "string",
          "required": false,
          "default": "0"
        },
        {
          "index": 3,
          "name": "g1",
          "type": "int",
          "required": false
        },
        {
          "index": 4,
          "name": "g2",
          "type": "int",
          "required": false
        },
        {
          "index": 5,
          "name": "g3",
          "type": "int",
          "required": false
        },
        {
          "index": 6,
          "name": "g4",
          "type": "int",
          "required": false
        },
        {
          "index": 7,
          "name": "g5",
          "type": "int",
          "required": false
        },
        {
          "index": 8,
          "name": "g6",
          "type": "int",
          "required": false
        },
        {
          "index": 9,
          "name": "g7",
          "type": "int",
          "required": false
        },
        {
          "index": 10,
          "name": "g8",
          "type": "int",
          "required": false
        },
        {
          "index": 11,
          "name": "g9",
          "type": "int",
          "required": false
        }
      ]
    },
    "BEGIN BULK": {
      "fields": [],
      "structural": true
    },
    "CEND": {
      "fields": [],
      "structural": true
    },
    "DISPLACEMENT": {
      "fields": [],
      "structural": true
    },
    "ENDDATA": {
      "fields": [],
      "structural": true
    },
    "INCLUDE": {
      "fields": [],
      "structural": true
    },
    "SOL": {
      "fields": [],
      "structural": true
    },
    "STRESS": {
      "fields": [],
      "structural": true
    },
    "SUBCASE": {
      "fields": [],
      "structural": true
    }
  },
  "notes": [
    "Generated from pyNastran source using AST analysis.",
    "Some cards may require overrides for repeat/variant layouts."
  ]
};
