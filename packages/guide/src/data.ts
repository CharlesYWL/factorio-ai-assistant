import type { GuideSource, GuideStage, ProgressionGuide } from "./types.js";

/**
 * Built-in Factorio 2.0 base-game progression guide.
 *
 * Content is authored offline from the sources below and frozen in this file; the Companion
 * never fetches guides at runtime and never forwards web content to a model. See
 * `docs/guide.md` for the update process.
 */
export const GUIDE_VERSION = "1.0.0";
export const GUIDE_REVISION = 1;
export const GUIDE_FACTORIO_VERSION = "2.0.72";

const SOURCES: readonly GuideSource[] = [
  {
    id: "base-technology-2.0.72",
    title: "Factorio base mod technology prototypes",
    url: "https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/technology.lua",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game (base mod 2.0.72, Space Age not installed)",
  },
  {
    id: "base-recipe-2.0.72",
    title: "Factorio base mod recipe prototypes",
    url: "https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/recipe.lua",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game (base mod 2.0.72, Space Age not installed)",
  },
  {
    id: "base-entity-2.0.72",
    title: "Factorio base mod entity prototypes (rocket_parts_required)",
    url: "https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/entity/entities.lua",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game (base mod 2.0.72, Space Age not installed)",
  },
  {
    id: "wiki-technologies",
    title: "Factorio Wiki: Technologies",
    url: "https://wiki.factorio.com/Technologies",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game",
  },
  {
    id: "wiki-science-pack",
    title: "Factorio Wiki: Science pack",
    url: "https://wiki.factorio.com/Science_pack",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game",
  },
  {
    id: "wiki-electronics-research",
    title: "Factorio Wiki: Electronics (research)",
    url: "https://wiki.factorio.com/Electronics_(research)",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game",
  },
  {
    id: "wiki-oil-processing-research",
    title: "Factorio Wiki: Oil processing (research)",
    url: "https://wiki.factorio.com/Oil_processing_(research)",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game",
  },
  {
    id: "wiki-advanced-oil-processing",
    title: "Factorio Wiki: Advanced oil processing",
    url: "https://wiki.factorio.com/Advanced_oil_processing",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game",
  },
  {
    id: "wiki-rocket-silo",
    title: "Factorio Wiki: Rocket silo",
    url: "https://wiki.factorio.com/Rocket_silo",
    accessed: "2026-07-28",
    applies_to: "Factorio 2.0 base game (100 rocket parts; 50 only with Space Age)",
  },
];

const STAGES: readonly GuideStage[] = [
  {
    id: "bootstrap",
    order: 1,
    title: {
      "zh-CN": "开局手搓与燃烧动力",
      en: "Bootstrap and burner power",
    },
    goal: {
      "zh-CN": "从手搓过渡到蒸汽电力和第一台实验室，让红瓶研究可以持续跑起来。",
      en: "Move from hand crafting to steam power and the first lab so automation research can run.",
    },
    entry_technologies: [],
    completion_technologies: ["steam-power", "electronics", "automation-science-pack", "automation"],
    source_ids: ["base-technology-2.0.72", "wiki-electronics-research"],
    rules: [
      {
        id: "guide-1-1-steam-power",
        order: 1,
        objective: {
          "zh-CN":
            "先用燃烧采矿机和石炉把铁板做出来：制造满 50 个铁板会触发 steam-power，锅炉、蒸汽机和小电杆随即解锁。",
          en: "Use burner drills and stone furnaces to make iron plates: crafting 50 iron plates triggers steam-power, which unlocks the boiler, steam engine, and small electric pole.",
        },
        rationale: {
          "zh-CN":
            "2.0 把 steam-power 改成触发科技（制造 50 铁板），电力不再需要科研瓶，所以第一优先级是铁板产量而不是研究。",
          en: "In 2.0 steam-power is a trigger technology (craft 50 iron plates), so early power costs no science; iron plate output, not research, is the first priority.",
        },
        verification: {
          "zh-CN": "steam-power 出现在已研究科技中，并且 iron-plate 的 10m 产量大于 0。",
          en: "steam-power appears in researched technologies and the 10m iron-plate production rate is above zero.",
        },
        preconditions: [{ kind: "technology_missing", technology_id: "steam-power" }],
        verification_signals: [
          { kind: "technology_researched", technology_id: "steam-power" },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "iron-plate",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: ["guide-1-2-electronics-and-lab"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-1-2-electronics-and-lab",
        order: 2,
        objective: {
          "zh-CN":
            "手搓 10 个铜板触发 electronics（解锁绿电路、铜线、机械臂、实验室、小电杆），再造第一台实验室；制造实验室会触发 automation-science-pack。",
          en: "Hand-craft 10 copper plates to trigger electronics (electronic circuit, copper cable, inserter, lab, small pole), then build the first lab; crafting a lab triggers automation-science-pack.",
        },
        rationale: {
          "zh-CN":
            "2.0 的 electronics 和 automation-science-pack 都是触发科技，不消耗科研瓶；先解锁它们才能开始任何研究。",
          en: "Both electronics and automation-science-pack are trigger technologies in 2.0 and cost no science packs; unlocking them is what makes research possible at all.",
        },
        verification: {
          "zh-CN": "automation-science-pack 已研究，且实验室有红瓶输入。",
          en: "automation-science-pack is researched and the lab is being fed automation science packs.",
        },
        preconditions: [
          { kind: "technology_missing", technology_id: "automation-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "automation-science-pack" },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "automation-science-pack",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: ["guide-1-3-first-red-science"],
        source_ids: ["base-technology-2.0.72", "wiki-electronics-research"],
      },
      {
        id: "guide-1-3-first-red-science",
        order: 3,
        objective: {
          "zh-CN":
            "手搓红瓶（1 铜板 + 1 铁齿轮 / 5 秒）研究 automation（10 红瓶），拿到组装机 1 和长臂机械臂后再谈自动化。",
          en: "Hand-feed automation science packs (1 copper plate + 1 iron gear wheel, 5 s) to research automation (10 packs), which unlocks assembling machine 1 and the long-handed inserter.",
        },
        rationale: {
          "zh-CN":
            "automation 只要 10 个红瓶，是全流程性价比最高的一次研究；没有组装机 1 之前所有产线都要手搓。",
          en: "automation costs only 10 packs and is the cheapest unlock in the run; without assembling machine 1 every line stays hand-crafted.",
        },
        verification: {
          "zh-CN": "automation 已研究，且场上有组装机 1 在生产红瓶。",
          en: "automation is researched and assembling machine 1 units are producing automation science packs.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "automation-science-pack" },
          { kind: "technology_missing", technology_id: "automation" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "automation" },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72"],
      },
    ],
  },
  {
    id: "automation-red-green",
    order: 2,
    title: {
      "zh-CN": "自动化与红/绿瓶",
      en: "Automation and red/green science",
    },
    goal: {
      "zh-CN": "红瓶和绿瓶都由组装机自动生产，并解锁钢材，为主线物流做准备。",
      en: "Automate both automation and logistic science packs and unlock steel in preparation for a main bus.",
    },
    entry_technologies: ["automation"],
    completion_technologies: ["logistic-science-pack", "steel-processing", "logistics"],
    source_ids: ["base-technology-2.0.72", "wiki-science-pack"],
    rules: [
      {
        id: "guide-2-1-automate-red-science",
        order: 1,
        objective: {
          "zh-CN":
            "先把红瓶做成自动产线：组装机 1 速度 0.5、配方 5 秒，一台 6/min，做到 15/min 大约要 3 台并配好铜板与铁齿轮供给。",
          en: "Automate automation science first: assembling machine 1 has 0.5 crafting speed and the recipe takes 5 s, so one machine yields 6/min and about three are needed for 15/min plus copper plate and gear supply.",
        },
        rationale: {
          "zh-CN":
            "这一阶段所有科技都只吃红瓶（automation 10、logistics 20、steel-processing 50、logistic-science-pack 75），红瓶速率直接决定研究速度。",
          en: "Every technology at this point costs only automation science (automation 10, logistics 20, steel-processing 50, logistic-science-pack 75), so red science rate directly sets research speed.",
        },
        verification: {
          "zh-CN": "automation-science-pack 的 10m 产量至少 15/min 且没有长期消费缺口。",
          en: "The 10m automation-science-pack production rate is at least 15/min with no sustained consumption deficit.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "automation" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "automation-science-pack",
            window: "10m",
            per_minute: 15,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "automation-science-pack",
            window: "10m",
            per_minute: 15,
          },
        ],
        next_rule_ids: ["guide-2-2-logistic-science-pack"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-2-2-logistic-science-pack",
        order: 2,
        objective: {
          "zh-CN":
            "研究 logistic-science-pack（75 红瓶），然后自动化绿瓶：配方是 1 传送带 + 1 机械臂 / 6 秒，两条子产线都要用组装机喂。",
          en: "Research logistic-science-pack (75 automation science), then automate green science: the recipe is 1 transport belt + 1 inserter over 6 s, both fed by their own assembler lines.",
        },
        rationale: {
          "zh-CN":
            "绿瓶是后续几乎所有科技的第二种成本；越早接上，中期研究越不会卡在单一瓶子上。",
          en: "Logistic science is the second cost of nearly every later technology; automating it early prevents mid-game research from stalling on a single pack.",
        },
        verification: {
          "zh-CN": "logistic-science-pack 已研究，且其 10m 产量与红瓶同档。",
          en: "logistic-science-pack is researched and its 10m production rate matches the red science rate.",
        },
        preconditions: [
          { kind: "technology_missing", technology_id: "logistic-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "logistic-science-pack" },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "logistic-science-pack",
            window: "10m",
            per_minute: 15,
          },
        ],
        next_rule_ids: ["guide-2-3-steel-processing"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-2-3-steel-processing",
        order: 3,
        objective: {
          "zh-CN":
            "研究 steel-processing（50 红瓶）并单独留一排熔炉做钢材：1 钢板 = 5 铁板 / 16 秒，混在铁板线里必然抢料。",
          en: "Research steel-processing (50 automation science) and dedicate a separate furnace row to steel: 1 steel plate costs 5 iron plates over 16 s and will starve the iron line if mixed in.",
        },
        rationale: {
          "zh-CN":
            "steel-processing 是 automation-2、engine、military-2、solar-energy、electric-energy-distribution-1 和 advanced-material-processing 的共同前置。",
          en: "steel-processing is a shared prerequisite of automation-2, engine, military-2, solar-energy, electric-energy-distribution-1, and advanced-material-processing.",
        },
        verification: {
          "zh-CN": "steel-processing 已研究，且 steel-plate 的 10m 产量大于 0。",
          en: "steel-processing is researched and the 10m steel-plate production rate is above zero.",
        },
        preconditions: [{ kind: "technology_missing", technology_id: "steel-processing" }],
        verification_signals: [
          { kind: "technology_researched", technology_id: "steel-processing" },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "steel-plate",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-2-4-green-science-throughput",
        order: 4,
        objective: {
          "zh-CN":
            "绿瓶产量落后于红瓶时，先补机械臂和传送带两条子产线，而不是继续开新科技分支。",
          en: "When green science lags red science, expand the inserter and transport belt sub-lines first instead of opening new research branches.",
        },
        rationale: {
          "zh-CN":
            "红/绿瓶不均衡时实验室会空转，研究速度按最慢的那种瓶子计算。",
          en: "Unbalanced red/green output idles the labs; research speed is set by the slowest pack.",
        },
        verification: {
          "zh-CN": "logistic-science-pack 的 10m 产量至少 15/min。",
          en: "The 10m logistic-science-pack production rate is at least 15/min.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "logistic-science-pack" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "logistic-science-pack",
            window: "10m",
            per_minute: 15,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "logistic-science-pack",
            window: "10m",
            per_minute: 15,
          },
        ],
        next_rule_ids: [],
        source_ids: ["wiki-science-pack"],
      },
    ],
  },
  {
    id: "smelting-logistics-military",
    order: 3,
    title: {
      "zh-CN": "冶炼、主线物流与军工基础",
      en: "Smelting, main bus, and military basics",
    },
    goal: {
      "zh-CN":
        "把铁板、铜板、钢板和绿电路做成可扩展的主线，补上黑瓶与防线，并解锁进入石油阶段的前置。",
      en: "Turn iron, copper, steel, and green circuits into a scalable bus, add military science and defenses, and unlock the prerequisites for the oil stage.",
    },
    entry_technologies: ["logistic-science-pack", "steel-processing"],
    completion_technologies: [
      "advanced-material-processing",
      "logistics-2",
      "automation-2",
      "engine",
      "fluid-handling",
      "oil-gathering",
    ],
    source_ids: ["base-technology-2.0.72"],
    rules: [
      {
        id: "guide-3-1-steel-furnace-bus",
        order: 1,
        objective: {
          "zh-CN":
            "研究 advanced-material-processing（75 红+绿）换成钢炉，并把铁板、铜板、钢板、绿电路四条料拉成主线，两侧留出取料口。",
          en: "Research advanced-material-processing (75 red + green) for steel furnaces and lay iron plate, copper plate, steel plate, and green circuits out as a main bus with side taps.",
        },
        rationale: {
          "zh-CN":
            "石油阶段之后每条新产线都要从这四种基础料取用；提前做成主线可以避免后面反复拆线。",
          en: "Every line added after the oil stage draws from these four base materials; building the bus now avoids repeated rebuilds later.",
        },
        verification: {
          "zh-CN": "advanced-material-processing 已研究，且铁板 10m 净流量不为负。",
          en: "advanced-material-processing is researched and the 10m iron plate net flow is not negative.",
        },
        preconditions: [
          { kind: "technology_missing", technology_id: "advanced-material-processing" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "advanced-material-processing" },
        ],
        next_rule_ids: ["guide-3-2-base-material-deficit"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-3-2-base-material-deficit",
        order: 2,
        objective: {
          "zh-CN":
            "铁板 10m 消费超过产量时，先加矿机和熔炉阵列补铁板，再考虑扩下游产线。",
          en: "When 10m iron plate consumption exceeds production, add drills and furnace rows for iron plate before expanding any downstream line.",
        },
        rationale: {
          "zh-CN":
            "铁板是绿电路、齿轮、钢板和几乎所有中间品的共同源头；上游为负时扩下游只会把缺口放大。",
          en: "Iron plate feeds green circuits, gears, steel, and nearly every intermediate; expanding downstream while the source is negative only amplifies the deficit.",
        },
        verification: {
          "zh-CN": "iron-plate 的 10m 产量不低于消费。",
          en: "The 10m iron plate production rate is at least its consumption rate.",
        },
        preconditions: [
          {
            kind: "flow_net_below",
            resource_kind: "item",
            resource_id: "iron-plate",
            window: "10m",
            per_minute: 0,
          },
        ],
        verification_signals: [
          {
            kind: "flow_net_below",
            resource_kind: "item",
            resource_id: "iron-plate",
            window: "10m",
            per_minute: 0,
          },
        ],
        next_rule_ids: [],
        source_ids: ["wiki-technologies"],
      },
      {
        id: "guide-3-3-military-science",
        order: 3,
        objective: {
          "zh-CN":
            "按 military → military-2 → stone-wall 顺序研究后拿下 military-science-pack（30 红+绿）；黑瓶配方是 1 穿甲弹 + 1 手雷 + 2 石墙 / 10 秒产 2 个。",
          en: "Research military, military-2, and stone-wall, then military-science-pack (30 red + green); the pack recipe is 1 piercing rounds magazine + 1 grenade + 2 stone walls over 10 s for 2 packs.",
        },
        rationale: {
          "zh-CN":
            "黑瓶不在火箭科技路径上，但军事升级和 laser-turret 需要它；污染扩散后再补通常来不及。",
          en: "Military science is not on the rocket path, but military upgrades and laser turrets need it, and retrofitting it after pollution spreads is usually too late.",
        },
        verification: {
          "zh-CN": "military-science-pack 已研究，且黑瓶 10m 产量大于 0。",
          en: "military-science-pack is researched and its 10m production rate is above zero.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "steel-processing" },
          { kind: "technology_missing", technology_id: "military-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "military-science-pack" },
        ],
        next_rule_ids: ["guide-3-4-oil-prerequisites"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-3-4-oil-prerequisites",
        order: 4,
        objective: {
          "zh-CN":
            "研究 automation-2（组装机 2）和 engine，再研究 fluid-handling（50 红+绿）与 oil-gathering（100 红+绿）拿到抽油机。",
          en: "Research automation-2 (assembling machine 2) and engine, then fluid-handling (50 red + green) and oil-gathering (100 red + green) to unlock the pumpjack.",
        },
        rationale: {
          "zh-CN":
            "2.0 把旧的 oil-processing 拆成三层：fluid-handling → oil-gathering → oil-processing（抽到第一桶原油自动触发），所以进石油阶段的实际门槛是 automation-2 与 engine。",
          en: "2.0 splits the old oil-processing tech into three layers — fluid-handling, oil-gathering, then oil-processing (auto-triggered by mining the first crude oil) — so the real gate into the oil stage is automation-2 plus engine.",
        },
        verification: {
          "zh-CN": "oil-gathering 已研究，抽油机已建，oil-processing 触发科技随之完成。",
          en: "oil-gathering is researched, a pumpjack is running, and the oil-processing trigger technology has completed.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "logistic-science-pack" },
          { kind: "technology_missing", technology_id: "oil-processing" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "oil-processing" },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72", "wiki-oil-processing-research"],
      },
    ],
  },
  {
    id: "oil-chemical-blue",
    order: 4,
    title: {
      "zh-CN": "原油、高级炼油、塑料/硫磺与蓝瓶",
      en: "Oil, advanced refining, plastic/sulfur, and blue science",
    },
    goal: {
      "zh-CN": "打通炼油到红电路与蓝瓶的整条化工链，并让三种油品都有去处。",
      en: "Complete the refining chain through advanced circuits and chemical science, and give every oil product a sink.",
    },
    entry_technologies: ["oil-processing"],
    completion_technologies: [
      "plastics",
      "sulfur-processing",
      "advanced-circuit",
      "chemical-science-pack",
      "advanced-oil-processing",
    ],
    source_ids: [
      "base-technology-2.0.72",
      "base-recipe-2.0.72",
      "wiki-advanced-oil-processing",
    ],
    rules: [
      {
        id: "guide-4-1-plastics-and-sulfur",
        order: 1,
        objective: {
          "zh-CN":
            "先研究 plastics（200 红+绿）和 sulfur-processing（150 红+绿）：塑料是 20 石油气 + 1 煤 / 1 秒产 2 个，硫磺是 30 石油气 + 30 水 / 1 秒产 2 个。",
          en: "Research plastics (200 red + green) and sulfur-processing (150 red + green) first: plastic is 20 petroleum gas + 1 coal per second for 2, sulfur is 30 petroleum gas + 30 water per second for 2.",
        },
        rationale: {
          "zh-CN":
            "这两条化工线是红电路和蓝瓶的唯一来源；basic oil processing（100 原油 → 45 石油气）已经足够先开塑料。",
          en: "These two chemical lines are the only sources for advanced circuits and chemical science; basic oil processing (100 crude oil to 45 petroleum gas) is already enough to start plastic.",
        },
        verification: {
          "zh-CN": "plastic-bar 与 sulfur 的 10m 产量都大于 0。",
          en: "Both plastic-bar and sulfur show a 10m production rate above zero.",
        },
        preconditions: [{ kind: "technology_missing", technology_id: "plastics" }],
        verification_signals: [
          { kind: "technology_researched", technology_id: "plastics" },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "plastic-bar",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: ["guide-4-2-advanced-circuit"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-4-2-advanced-circuit",
        order: 2,
        objective: {
          "zh-CN":
            "研究 advanced-circuit（200 红+绿）并建红电路线：2 绿电路 + 2 塑料 + 4 铜线 / 6 秒产 1 个，绿电路和铜线都要单独直供。",
          en: "Research advanced-circuit (200 red + green) and build the line: 2 electronic circuits + 2 plastic bars + 4 copper cable over 6 s for 1, with dedicated green circuit and copper cable feeds.",
        },
        rationale: {
          "zh-CN":
            "红电路是蓝瓶、modules、processing-unit 和 mining-productivity 的共同前置，产能不足会同时卡住四条路线。",
          en: "Advanced circuits gate chemical science, modules, processing units, and mining productivity at once, so a shortage stalls four branches together.",
        },
        verification: {
          "zh-CN": "advanced-circuit 的 10m 产量大于 0 且净流量不为负。",
          en: "The 10m advanced-circuit production rate is above zero and its net flow is not negative.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "plastics" },
          { kind: "technology_missing", technology_id: "advanced-circuit" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "advanced-circuit" },
        ],
        next_rule_ids: ["guide-4-3-chemical-science-pack"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-4-3-chemical-science-pack",
        order: 3,
        objective: {
          "zh-CN":
            "研究 chemical-science-pack（75 红+绿）并自动化蓝瓶：3 红电路 + 2 引擎 + 1 硫磺 / 24 秒产 2 个，引擎需要 automation-2 之后的高级制造。",
          en: "Research chemical-science-pack (75 red + green) and automate blue science: 3 advanced circuits + 2 engine units + 1 sulfur over 24 s for 2 packs, with engine units made in an advanced crafting machine.",
        },
        rationale: {
          "zh-CN":
            "蓝瓶是 advanced-oil-processing、robotics、processing-unit、electric furnace 等中期科技的共同成本。",
          en: "Chemical science is the shared cost of advanced-oil-processing, robotics, processing units, and the electric furnace.",
        },
        verification: {
          "zh-CN": "chemical-science-pack 已研究且 10m 产量大于 0。",
          en: "chemical-science-pack is researched and its 10m production rate is above zero.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "advanced-circuit" },
          { kind: "technology_researched", technology_id: "sulfur-processing" },
          { kind: "technology_missing", technology_id: "chemical-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "chemical-science-pack" },
        ],
        next_rule_ids: ["guide-4-4-advanced-oil-processing"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-4-4-advanced-oil-processing",
        order: 4,
        objective: {
          "zh-CN":
            "研究 advanced-oil-processing（75 红+绿+蓝）：100 原油 + 50 水 / 5 秒产 25 重油 + 45 轻油 + 55 石油气，并同时接上重油裂解和轻油裂解。",
          en: "Research advanced-oil-processing (75 red + green + blue): 100 crude oil + 50 water over 5 s yields 25 heavy oil, 45 light oil, and 55 petroleum gas; add heavy and light oil cracking at the same time.",
        },
        rationale: {
          "zh-CN":
            "高级炼油同时产出三种油品，任何一种堵住都会停整座炼油厂；裂解链（40 重油 + 30 水 → 30 轻油；30 轻油 + 30 水 → 20 石油气）是唯一的泄压口。",
          en: "Advanced refining produces three fluids at once and a single backed-up output stops the whole refinery; cracking (40 heavy + 30 water to 30 light; 30 light + 30 water to 20 petroleum) is the only relief valve.",
        },
        verification: {
          "zh-CN": "advanced-oil-processing 已研究，且重油与轻油的 10m 净积压没有持续增长。",
          en: "advanced-oil-processing is researched and neither heavy nor light oil shows a persistent 10m net surplus.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "chemical-science-pack" },
          { kind: "technology_missing", technology_id: "advanced-oil-processing" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "advanced-oil-processing" },
        ],
        next_rule_ids: ["guide-4-5-petroleum-deficit"],
        source_ids: ["base-recipe-2.0.72", "wiki-advanced-oil-processing"],
      },
      {
        id: "guide-4-5-petroleum-deficit",
        order: 5,
        objective: {
          "zh-CN":
            "石油气 10m 净流量为负时，先加轻油裂解把轻油转成石油气，再考虑加抽油机或新油田。",
          en: "When 10m petroleum gas net flow is negative, add light oil cracking to convert light oil into petroleum before adding pumpjacks or a new oil field.",
        },
        rationale: {
          "zh-CN":
            "塑料和硫磺都只吃石油气；在已经有高级炼油的存档里，裂解不足比原油不足更常见。",
          en: "Plastic and sulfur consume only petroleum gas; in a save that already runs advanced refining, missing cracking is a more common cause than missing crude.",
        },
        verification: {
          "zh-CN": "petroleum-gas 的 10m 产量不低于消费。",
          en: "The 10m petroleum gas production rate is at least its consumption rate.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "advanced-oil-processing" },
          {
            kind: "flow_net_below",
            resource_kind: "fluid",
            resource_id: "petroleum-gas",
            window: "10m",
            per_minute: 0,
          },
        ],
        verification_signals: [
          {
            kind: "flow_net_below",
            resource_kind: "fluid",
            resource_id: "petroleum-gas",
            window: "10m",
            per_minute: 0,
          },
        ],
        next_rule_ids: [],
        source_ids: ["wiki-advanced-oil-processing"],
      },
    ],
  },
  {
    id: "robotics-modules-scale",
    order: 5,
    title: {
      "zh-CN": "机器人、模块与规模化",
      en: "Robots, modules, and scaling",
    },
    goal: {
      "zh-CN": "拿到建设机器人、插件和蓝电路，把蓝瓶产线扩到能支撑紫瓶前置研究。",
      en: "Unlock construction robots, modules, and processing units, and scale blue science enough to fund the purple science prerequisites.",
    },
    entry_technologies: ["chemical-science-pack"],
    completion_technologies: [
      "robotics",
      "construction-robotics",
      "modules",
      "processing-unit",
      "railway",
      "advanced-material-processing-2",
    ],
    source_ids: ["base-technology-2.0.72"],
    rules: [
      {
        id: "guide-5-1-construction-robotics",
        order: 1,
        objective: {
          "zh-CN":
            "沿 lubricant → electric-engine → battery 补齐前置后研究 robotics（75 红+绿+蓝），再研究 construction-robotics（100 红+绿+蓝）拿建设机器人和个人机器人港。",
          en: "Fill in lubricant, electric-engine, and battery, then research robotics (75 red + green + blue) and construction-robotics (100 red + green + blue) for construction robots and the personal roboport.",
        },
        rationale: {
          "zh-CN":
            "建设机器人把蓝图施工从手动改为自动，是这一阶段收益最高的单项研究；lubricant 需要先有 advanced-oil-processing。",
          en: "Construction robots turn blueprint building from manual to automatic and are the highest-return research of this stage; lubricant requires advanced-oil-processing first.",
        },
        verification: {
          "zh-CN": "construction-robotics 已研究，且场上有机器人港在执行蓝图。",
          en: "construction-robotics is researched and roboports are executing blueprints.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "chemical-science-pack" },
          { kind: "technology_missing", technology_id: "construction-robotics" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "construction-robotics" },
        ],
        next_rule_ids: ["guide-5-2-modules"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-5-2-modules",
        order: 2,
        objective: {
          "zh-CN":
            "研究 modules（100 红+绿）和 productivity-module（50 红+绿）：产能插件 1 是 5 红电路 + 5 绿电路 / 15 秒，也是紫瓶配方的直接原料。",
          en: "Research modules (100 red + green) and productivity-module (50 red + green): productivity module 1 costs 5 advanced circuits + 5 electronic circuits over 15 s and is also a direct ingredient of purple science.",
        },
        rationale: {
          "zh-CN":
            "productivity-module 是 production-science-pack 的三个前置之一，且紫瓶配方本身就要消耗产能插件 1。",
          en: "productivity-module is one of the three prerequisites of production-science-pack, and the purple science recipe itself consumes productivity module 1.",
        },
        verification: {
          "zh-CN": "productivity-module 已研究，且产能插件已经自动化生产。",
          en: "productivity-module is researched and productivity modules are produced automatically.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "advanced-circuit" },
          { kind: "technology_missing", technology_id: "productivity-module" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "modules" },
          { kind: "technology_researched", technology_id: "productivity-module" },
        ],
        next_rule_ids: ["guide-5-3-processing-unit"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-5-3-processing-unit",
        order: 3,
        objective: {
          "zh-CN":
            "研究 processing-unit（300 红+绿+蓝）并建蓝电路线：20 绿电路 + 2 红电路 + 5 硫酸 / 10 秒产 1 个，硫酸要单独接一条化工线。",
          en: "Research processing-unit (300 red + green + blue) and build the line: 20 electronic circuits + 2 advanced circuits + 5 sulfuric acid over 10 s for 1, with a dedicated sulfuric acid line.",
        },
        rationale: {
          "zh-CN":
            "蓝电路是黄瓶和火箭部件的主要成本（每个火箭部件 10 个），绿电路需求会因此翻数倍。",
          en: "Processing units dominate the cost of utility science and rocket parts (10 per part), which multiplies green circuit demand several times over.",
        },
        verification: {
          "zh-CN": "processing-unit 的 10m 产量大于 0 且绿电路净流量不为负。",
          en: "The 10m processing-unit production rate is above zero and green circuit net flow is not negative.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "chemical-science-pack" },
          { kind: "technology_missing", technology_id: "processing-unit" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "processing-unit" },
        ],
        next_rule_ids: ["guide-5-4-blue-science-throughput"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-5-4-blue-science-throughput",
        order: 4,
        objective: {
          "zh-CN":
            "把蓝瓶稳定到至少 45/min 再开紫瓶分支：advanced-material-processing-2 要 250 瓶、processing-unit 要 300 瓶、logistic-robotics 要 250 瓶。",
          en: "Stabilize blue science at 45/min before opening the purple branch: advanced-material-processing-2 costs 250, processing-unit 300, and logistic-robotics 250.",
        },
        rationale: {
          "zh-CN":
            "这一阶段的科技成本比红/绿阶段高一个量级，蓝瓶速率不足会让每项研究拖到十几分钟。",
          en: "Technology costs here are an order of magnitude above the red/green stage; a slow blue science line stretches each research to tens of minutes.",
        },
        verification: {
          "zh-CN": "chemical-science-pack 的 10m 产量至少 45/min。",
          en: "The 10m chemical-science-pack production rate is at least 45/min.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "chemical-science-pack" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "chemical-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "chemical-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        next_rule_ids: ["guide-5-5-railway"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-5-5-railway",
        order: 5,
        objective: {
          "zh-CN":
            "研究 railway（75 红+绿）并把第一条矿石铁路接进主基地；铁轨是 1 石头 + 1 铁棍 + 1 钢板 / 产 2 条。",
          en: "Research railway (75 red + green) and run the first ore train into the main base; rail is 1 stone + 1 iron stick + 1 steel plate for 2 pieces.",
        },
        rationale: {
          "zh-CN":
            "railway 是 production-science-pack 的三个前置之一，紫瓶配方本身每次也要 30 条铁轨。",
          en: "railway is one of the three prerequisites of production-science-pack, and the purple science recipe itself consumes 30 rails per craft.",
        },
        verification: {
          "zh-CN": "railway 已研究，且 rail 的 10m 产量大于 0。",
          en: "railway is researched and the 10m rail production rate is above zero.",
        },
        preconditions: [{ kind: "technology_missing", technology_id: "railway" }],
        verification_signals: [
          { kind: "technology_researched", technology_id: "railway" },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
    ],
  },
  {
    id: "production-science",
    order: 6,
    title: {
      "zh-CN": "紫瓶与生产科技",
      en: "Purple science and production technology",
    },
    goal: {
      "zh-CN": "补齐紫瓶的三个前置并让紫瓶成线，解锁 3 级插件和蓝带的研究路径。",
      en: "Complete the three purple science prerequisites, get the line running, and open the level 3 module and express belt path.",
    },
    entry_technologies: ["robotics", "productivity-module"],
    completion_technologies: ["production-science-pack", "logistics-3"],
    source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
    rules: [
      {
        id: "guide-6-1-electric-furnace",
        order: 1,
        objective: {
          "zh-CN":
            "研究 advanced-material-processing-2（250 红+绿+蓝）拿电炉；紫瓶配方每次要 1 台电炉，必须给它单独一条组装线。",
          en: "Research advanced-material-processing-2 (250 red + green + blue) for the electric furnace; each purple science craft consumes one electric furnace, so give it a dedicated assembler line.",
        },
        rationale: {
          "zh-CN":
            "电炉是紫瓶三种输入里最贵的一项，也是 production-science-pack 的直接前置。",
          en: "The electric furnace is the most expensive of the three purple inputs and a direct prerequisite of production-science-pack.",
        },
        verification: {
          "zh-CN": "advanced-material-processing-2 已研究，且电炉在自动生产。",
          en: "advanced-material-processing-2 is researched and electric furnaces are produced automatically.",
        },
        preconditions: [
          { kind: "technology_missing", technology_id: "advanced-material-processing-2" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "advanced-material-processing-2" },
        ],
        next_rule_ids: ["guide-6-2-production-science-pack"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-6-2-production-science-pack",
        order: 2,
        objective: {
          "zh-CN":
            "研究 production-science-pack（100 红+绿+蓝）并自动化紫瓶：1 电炉 + 1 产能插件 1 + 30 铁轨 / 21 秒产 3 个。",
          en: "Research production-science-pack (100 red + green + blue) and automate purple science: 1 electric furnace + 1 productivity module + 30 rails over 21 s for 3 packs.",
        },
        rationale: {
          "zh-CN":
            "紫瓶是 speed-module-3、productivity-module-3 和 logistics-3 的前置，而前两者又是 rocket-silo 的直接前置。",
          en: "Purple science gates speed-module-3, productivity-module-3, and logistics-3, and the first two are direct prerequisites of rocket-silo.",
        },
        verification: {
          "zh-CN": "production-science-pack 已研究且 10m 产量大于 0。",
          en: "production-science-pack is researched and its 10m production rate is above zero.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "advanced-material-processing-2" },
          { kind: "technology_researched", technology_id: "railway" },
          { kind: "technology_researched", technology_id: "productivity-module" },
          { kind: "technology_missing", technology_id: "production-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "production-science-pack" },
        ],
        next_rule_ids: ["guide-6-3-purple-throughput"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-6-3-purple-throughput",
        order: 3,
        objective: {
          "zh-CN":
            "紫瓶产量不足时，按电炉、产能插件、铁轨三条输入依次排查，其中铁轨需求最大（每 3 个紫瓶要 30 条）。",
          en: "When purple science is short, check the electric furnace, productivity module, and rail feeds in that order; rails dominate demand at 30 per 3 packs.",
        },
        rationale: {
          "zh-CN":
            "紫瓶的三种输入都是成品而不是基础料，任何一条子产线停摆都会直接让紫瓶归零。",
          en: "All three purple inputs are finished goods rather than base materials, so any stalled sub-line drops purple science to zero.",
        },
        verification: {
          "zh-CN": "production-science-pack 的 10m 产量至少 45/min。",
          en: "The 10m production-science-pack rate is at least 45/min.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "production-science-pack" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "production-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "production-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        next_rule_ids: [],
        source_ids: ["base-recipe-2.0.72"],
      },
    ],
  },
  {
    id: "utility-science",
    order: 7,
    title: {
      "zh-CN": "黄瓶与 3 级插件",
      en: "Utility science and level 3 modules",
    },
    goal: {
      "zh-CN": "把低密度结构、蓝电路和飞行机器人框架做成线，产出黄瓶并研究出两种 3 级插件。",
      en: "Turn low density structures, processing units, and flying robot frames into lines, produce utility science, and research both level 3 modules.",
    },
    entry_technologies: ["production-science-pack"],
    completion_technologies: [
      "utility-science-pack",
      "speed-module-3",
      "productivity-module-3",
    ],
    source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
    rules: [
      {
        id: "guide-7-1-low-density-structure",
        order: 1,
        objective: {
          "zh-CN":
            "研究 low-density-structure（300 红+绿+蓝）并建线：2 钢板 + 20 铜板 + 5 塑料 / 15 秒产 1 个，铜板需求最大。",
          en: "Research low-density-structure (300 red + green + blue) and build the line: 2 steel plates + 20 copper plates + 5 plastic bars over 15 s for 1, with copper plate as the dominant input.",
        },
        rationale: {
          "zh-CN":
            "低密度结构同时是黄瓶（每 3 个黄瓶要 3 个）和火箭部件（每个部件要 10 个）的原料，是后期铜板消耗的主要来源。",
          en: "Low density structures feed both utility science (3 per 3 packs) and rocket parts (10 per part) and become the main late-game copper sink.",
        },
        verification: {
          "zh-CN": "low-density-structure 的 10m 产量大于 0 且铜板净流量不为负。",
          en: "The 10m low-density-structure rate is above zero and copper plate net flow is not negative.",
        },
        preconditions: [
          { kind: "technology_missing", technology_id: "low-density-structure" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "low-density-structure" },
        ],
        next_rule_ids: ["guide-7-2-utility-science-pack"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-7-2-utility-science-pack",
        order: 2,
        objective: {
          "zh-CN":
            "研究 utility-science-pack（100 红+绿+蓝+紫）并自动化黄瓶：3 低密度结构 + 2 蓝电路 + 1 飞行机器人框架 / 21 秒产 3 个。",
          en: "Research utility-science-pack (100 red + green + blue + purple) and automate it: 3 low density structures + 2 processing units + 1 flying robot frame over 21 s for 3 packs.",
        },
        rationale: {
          "zh-CN":
            "utility-science-pack 需要 robotics、processing-unit、low-density-structure 三项全部完成，而它本身又是 rocket-silo 的直接前置。",
          en: "utility-science-pack requires robotics, processing-unit, and low-density-structure together, and is itself a direct prerequisite of rocket-silo.",
        },
        verification: {
          "zh-CN": "utility-science-pack 已研究且 10m 产量大于 0。",
          en: "utility-science-pack is researched and its 10m production rate is above zero.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "low-density-structure" },
          { kind: "technology_researched", technology_id: "processing-unit" },
          { kind: "technology_missing", technology_id: "utility-science-pack" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "utility-science-pack" },
        ],
        next_rule_ids: ["guide-7-3-level-three-modules"],
        source_ids: ["base-technology-2.0.72", "base-recipe-2.0.72"],
      },
      {
        id: "guide-7-3-level-three-modules",
        order: 3,
        objective: {
          "zh-CN":
            "研究 speed-module-3 和 productivity-module-3（各 300 红+绿+蓝+紫），两项都是 rocket-silo 的直接前置。",
          en: "Research speed-module-3 and productivity-module-3 (300 red + green + blue + purple each); both are direct prerequisites of rocket-silo.",
        },
        rationale: {
          "zh-CN":
            "这两项没有替代路径，火箭研究会同时卡在它们和 concrete、rocket-fuel、solar-energy、electric-energy-accumulators、radar 上。",
          en: "There is no alternative path to these two, and rocket research is blocked by them alongside concrete, rocket-fuel, solar-energy, electric-energy-accumulators, and radar.",
        },
        verification: {
          "zh-CN": "speed-module-3 与 productivity-module-3 都已研究。",
          en: "Both speed-module-3 and productivity-module-3 are researched.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "production-science-pack" },
          { kind: "technology_missing", technology_id: "productivity-module-3" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "productivity-module-3" },
          { kind: "technology_researched", technology_id: "speed-module-3" },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-7-4-utility-throughput",
        order: 4,
        objective: {
          "zh-CN": "黄瓶产量不足时优先补飞行机器人框架和蓝电路两条子产线。",
          en: "When utility science is short, expand the flying robot frame and processing unit sub-lines first.",
        },
        rationale: {
          "zh-CN":
            "rocket-silo 本身要 1000 个五色瓶，黄瓶通常是其中最慢的一种。",
          en: "rocket-silo itself costs 1000 of each of the five packs, and utility science is usually the slowest of them.",
        },
        verification: {
          "zh-CN": "utility-science-pack 的 10m 产量至少 45/min。",
          en: "The 10m utility-science-pack rate is at least 45/min.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "utility-science-pack" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "utility-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "utility-science-pack",
            window: "10m",
            per_minute: 45,
          },
        ],
        next_rule_ids: [],
        source_ids: ["base-technology-2.0.72"],
      },
    ],
  },
  {
    id: "rocket-launch",
    order: 8,
    title: {
      "zh-CN": "火箭与首轮通关准备",
      en: "Rocket and first launch preparation",
    },
    goal: {
      "zh-CN": "研究并建成火箭发射井，凑齐 100 个火箭部件和一颗卫星，完成首次发射。",
      en: "Research and build the rocket silo, produce 100 rocket parts and a satellite, and complete the first launch.",
    },
    entry_technologies: ["utility-science-pack"],
    completion_technologies: ["rocket-silo", "space-science-pack"],
    source_ids: [
      "base-technology-2.0.72",
      "base-recipe-2.0.72",
      "base-entity-2.0.72",
      "wiki-rocket-silo",
    ],
    rules: [
      {
        id: "guide-8-1-rocket-silo-prerequisites",
        order: 1,
        objective: {
          "zh-CN":
            "补齐 rocket-silo 的八个前置：concrete、rocket-fuel、electric-energy-accumulators、solar-energy、utility-science-pack、speed-module-3、productivity-module-3、radar，然后研究 rocket-silo（1000 红+绿+蓝+紫+黄）。",
          en: "Complete the eight rocket-silo prerequisites — concrete, rocket-fuel, electric-energy-accumulators, solar-energy, utility-science-pack, speed-module-3, productivity-module-3, radar — then research rocket-silo (1000 red + green + blue + purple + yellow).",
        },
        rationale: {
          "zh-CN":
            "rocket-silo 不需要黑瓶，但 1000 个五色瓶的成本意味着五条科研线必须同时稳定。",
          en: "rocket-silo needs no military science, but the 1000-pack cost of five colors means all five science lines must be stable at once.",
        },
        verification: {
          "zh-CN": "rocket-silo 已研究，火箭发射井、火箭部件、卫星和货运着陆场配方全部解锁。",
          en: "rocket-silo is researched and the rocket silo, rocket part, satellite, and cargo landing pad recipes are all unlocked.",
        },
        preconditions: [{ kind: "technology_missing", technology_id: "rocket-silo" }],
        verification_signals: [
          { kind: "technology_researched", technology_id: "rocket-silo" },
        ],
        next_rule_ids: ["guide-8-2-rocket-part-lines"],
        source_ids: ["base-technology-2.0.72"],
      },
      {
        id: "guide-8-2-rocket-part-lines",
        order: 2,
        objective: {
          "zh-CN":
            "原版一枚火箭需要 100 个火箭部件，每个部件是 10 蓝电路 + 10 低密度结构 + 10 火箭燃料 / 3 秒，也就是共 1000 蓝电路 + 1000 低密度结构 + 1000 火箭燃料。",
          en: "A base-game rocket needs 100 rocket parts, each 10 processing units + 10 low density structures + 10 rocket fuel over 3 s, i.e. 1000 of each in total.",
        },
        rationale: {
          "zh-CN":
            "50 个部件是 Space Age 的数值，原版是 100；火箭燃料链（10 固体燃料 + 10 轻油 / 15 秒）通常是最先断的一条。",
          en: "50 parts is the Space Age value; the base game needs 100, and the rocket fuel chain (10 solid fuel + 10 light oil over 15 s) is usually the first to run dry.",
        },
        verification: {
          "zh-CN": "蓝电路、低密度结构和火箭燃料三条线的 10m 产量都大于 0 且净流量不为负。",
          en: "Processing unit, low density structure, and rocket fuel all show a 10m production rate above zero with non-negative net flow.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "rocket-silo" },
          { kind: "technology_missing", technology_id: "space-science-pack" },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "rocket-fuel",
            window: "10m",
            per_minute: 1,
          },
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "low-density-structure",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: ["guide-8-3-satellite-launch"],
        source_ids: ["base-recipe-2.0.72", "base-entity-2.0.72", "wiki-rocket-silo"],
      },
      {
        id: "guide-8-3-satellite-launch",
        order: 3,
        objective: {
          "zh-CN":
            "造一颗卫星（100 低密度结构 + 100 太阳能板 + 100 蓄电池 + 5 雷达 + 100 蓝电路 + 50 火箭燃料）、放置一座货运着陆场，然后装载发射完成首轮通关。",
          en: "Build one satellite (100 low density structures + 100 solar panels + 100 accumulators + 5 radars + 100 processing units + 50 rocket fuel), place a cargo landing pad, then load and launch to finish the first run.",
        },
        rationale: {
          "zh-CN":
            "卫星和货运着陆场都由 rocket-silo 研究解锁；带卫星发射会返还白瓶，是继续无限科技的入口。",
          en: "Both the satellite and the cargo landing pad are unlocked by the rocket-silo research; launching with a satellite returns space science packs and opens the infinite research path.",
        },
        verification: {
          "zh-CN": "space-science-pack 触发科技完成，白瓶进入实验室。",
          en: "The space-science-pack trigger technology completes and space science packs reach the labs.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "rocket-silo" },
        ],
        verification_signals: [
          { kind: "technology_researched", technology_id: "space-science-pack" },
        ],
        next_rule_ids: [],
        source_ids: ["base-recipe-2.0.72", "base-technology-2.0.72", "wiki-rocket-silo"],
      },
      {
        id: "guide-8-4-rocket-fuel-supply",
        order: 4,
        objective: {
          "zh-CN":
            "火箭燃料 10m 产量为 0 时，先接固体燃料线（10 轻油 → 1 固体燃料）再扩火箭燃料组装机。",
          en: "When 10m rocket fuel production is zero, restore the solid fuel line (10 light oil to 1 solid fuel) before adding rocket fuel assemblers.",
        },
        rationale: {
          "zh-CN":
            "火箭燃料同时吃固体燃料和轻油；轻油被裂解全部转成石油气时，这条线会安静地停掉。",
          en: "Rocket fuel consumes both solid fuel and light oil, and the line stops silently when cracking converts all light oil into petroleum gas.",
        },
        verification: {
          "zh-CN": "rocket-fuel 的 10m 产量大于 0。",
          en: "The 10m rocket-fuel production rate is above zero.",
        },
        preconditions: [
          { kind: "technology_researched", technology_id: "rocket-silo" },
          {
            kind: "flow_produced_below",
            resource_kind: "item",
            resource_id: "rocket-fuel",
            window: "10m",
            per_minute: 1,
          },
        ],
        verification_signals: [
          {
            kind: "flow_produced_at_least",
            resource_kind: "item",
            resource_id: "rocket-fuel",
            window: "10m",
            per_minute: 1,
          },
        ],
        next_rule_ids: [],
        source_ids: ["base-recipe-2.0.72"],
      },
    ],
  },
];

export const VANILLA_PROGRESSION_GUIDE: ProgressionGuide = {
  guide_version: GUIDE_VERSION,
  guide_revision: GUIDE_REVISION,
  game: "factorio-base",
  factorio_version: GUIDE_FACTORIO_VERSION,
  data_source: "wube/factorio-data@2.0.72 base prototypes and wiki.factorio.com",
  sources: SOURCES,
  stages: STAGES,
};
