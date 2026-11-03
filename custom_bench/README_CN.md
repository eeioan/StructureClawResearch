# StructureClaw Benchmark

[English](README.md)

这是 [StructureClaw](https://github.com/structureclaw/structureclaw) 的公开、可复现评测运行器与评测集。

评测集包含 150 个中英双语结构工程场景：

| 任务族 | 场景数 | 目标 |
| --- | ---: | --- |
| `standard_workflow` | 50 | 明确需求 → 建模 → 分析 → 可选报告 |
| `interactive_robustness` | 50 | 缺失、非法、歧义、冲突或多轮输入 |
| `multimodal_reverse_engineering` | 50 | 图片与 DXF 反向建模 |

每个任务族均包含 25 个中文场景和 25 个英文场景。

## 公共范围

本仓库只保留检查和运行 benchmark 必需的内容：

- 声明式场景与类型化断言；
- 静态图片、图纸、工程模型与冻结数值真值；
- 运行器及其评分实现；
- 场景和结果数据合同。

## 目录

```text
benchmark.json       评测集标识、版本和预期数量
schemas/             场景与结果数据合同
scenarios/           按任务族组织的场景 JSON
fixtures/            冻结的公共输入与真值
lib/                 运行时评分与评测集校验
runner.cjs           公共 benchmark 入口
SPEC_CN.md           规范性评分合同
```

## 运行

在已经构建后端的 StructureClaw 工作区中：

```bash
node tests/runner.mjs llm-benchmark
node tests/runner.mjs llm-benchmark --scenario std-beam-6m-gt-repeat
node tests/runner.mjs llm-benchmark --family standard_workflow
```

独立运行：

```bash
export SCLAW_ROOT=/path/to/structureclaw
export LLM_API_KEY=...

npm install
npm run validate
npm run benchmark -- --scenario std-beam-6m-gt-repeat
```

运行器还支持 `--mode`、`--output` 和 `--case-timeout-ms`。只有显式提供输出路径时才会写入 benchmark 结果。

## 可复现性

正式结果应记录 StructureClaw revision、benchmark revision、场景与附件哈希、评分哈希、运行时配置哈希、模型标识及分析运行时版本。已经发布的 benchmark 版本不得静默修改既有场景 ID 或评分语义。

断言语义与证据要求见 [SPEC_CN.md](SPEC_CN.md)。

## 许可证

MIT
