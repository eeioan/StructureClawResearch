# Benchmark 规范

[English](SPEC.md)

## 执行合同

运行器只读使用评测集。它可以从 `SCLAW_ROOT` 读取 StructureClaw 构建产物和设置，但不得从期望输出或真值推导 Agent 输入。只有显式指定输出路径时才能写入结果。

每个场景只尝试一次（`maxRetries: 0`）。多轮场景共享同一会话，并按每一轮声明的断言分别评分。场景超时属于执行失败，不得记为模型质量失败。

## 断言

| 断言 | 要求 |
| --- | --- |
| `structural_type` | 运行时结构类型与预期一致。 |
| `skill_match` | 路由命中声明的主 skill 或允许的别名。 |
| `has_model` | 存在合法可计算模型并满足声明的最小规模。 |
| `model_matches` | 几何、拓扑、约束、属性分配和荷载在显式容差内匹配冻结工程真值。 |
| `has_analysis` | 存在成功的分析工件。 |
| `engine_match` | 使用了指定的分析 skill 与分析引擎。 |
| `numerical_matches` | 求解响应在显式容差内匹配同引擎冻结真值。 |
| `has_report` | 存在有类型且可追溯到执行证据的报告工件。 |
| `report_numerical_consistency` | 报告数值与当前分析工件一致。 |
| `has_interaction_questions` | Agent 针对缺失或错误输入提出相关问题。 |
| `should_not_analyze` | 对不安全或信息不足的输入不调用分析。 |
| `no_bad_model` | 对不安全或信息不足的输入不生成可计算模型。 |
| `analysis_or_interaction` | 完成合法分析，或提出恰当的澄清问题。 |
| `natural_language` | 配置的 Judge 仅依据所提供的执行证据接受响应。 |

未知断言类型属于评测集配置错误。缺失的执行证据不得通过推测补全。

## 容差与真值

场景 JSON 中的显式容差具有权威性。冻结真值必须标识来源模型、分析引擎、荷载组合、单位和来源信息。只有在一对一工程映射保持声明关系时，实体 ID 才允许不同。

## 结果标识

可复现结果必须标识 StructureClaw revision、benchmark revision、场景与附件哈希、评分哈希、运行时配置哈希、模型角色、分析运行时、开始时间和完成状态。
