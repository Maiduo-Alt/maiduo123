/**
 * 离线运行 generateSemanticGoals：读取剧本问题序列 JSON，输出带语义目标的新序列。
 * 用法: node gen_goals.js <input.json> <output.json>
 * input:  { "buyerContext": "背景名/描述", "questions": [ ...ScriptQuestion ] }
 * output: [ ...ScriptQuestion ]（带 semanticGoals / conversationPlan / goalPriority）
 */
import { generateSemanticGoals } from '../src/domain/semantic-goal-generator';
import * as fs from 'fs';

const [inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
// 固定随机源，保证结果可复现（主目标选择取中位）
const stableRandom = () => 0.5;
const result = generateSemanticGoals(input.questions, input.buyerContext || '', stableRandom);
fs.writeFileSync(outputPath, JSON.stringify(result, null, 1), 'utf-8');
console.log(`questions=${result.length} goals=${result.reduce((n: number, q: any) => n + (q.semanticGoals?.length ? 1 : 0), 0)}`);
