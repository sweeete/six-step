// 六步思考 · 执行完整性 guard（新六步版）
// 六步：1是什么 → 2为什么 → 3怎么做 → 4任务划分 → 5执行 → 6审计（每步输出，审计不通过带结果回 1 循环，直到圆满完成）。
// 挂进 preset-six-step 的 config.plugins：作用域自动限定到选中「六步思考」预设的 agent。
// 机制：模型在最终答复之前必须调用 six_step_receipt 提交一份「六步凭证」；
// 轮次收工（agent/turn-stopping）时若凭证缺失/不完整（含任一子任务审计未通过、concluded 非 true），
// 就 agent.steer() 拉回重做，无次数上限，直到提交完整凭证才允许收工。
// 只强制「形式完整性」，不引入任何 LLM 裁决层 —— 第 6 步审计本身就是方法自带的裁决（用户 m00465）。
// 零 @deepseek-ai/* 静态依赖：只用 node:crypto + cordis 注入的 tools 服务 + ctx.logger。
// 注意：不再读 agent.session.header.agentPreset —— 该字段是会话创建期元数据，实测会误判，
// 且 guard 本就只挂在六步预设树里，无需再判断「是不是六步会话」。
import { randomUUID } from 'node:crypto';

export const name = 'six-step-guard';
export const inject = ['tools'];

const GUARD_SOURCE = { kind: 'six-step-guard' };
const FALLBACK = {};

// 工具执行与轮次事件必须落到同一个状态槽；极端情况下 exec.agent 缺失时用共享兜底槽。
const keyOf = (agent) => (agent && typeof agent === 'object' ? agent : FALLBACK);

// 复杂任务下 Lead 会派生 6 个 teammate 各做六步中的一步；teammate 继承本预设与 guard，
// 但只做单步、无法提交「完整六步凭证」，故收工时对其直接放行，强制仍只作用于顶层 Lead。
// 优先用 Team 服务的精确身份；服务不可达时退回 parentSession 兜底（顶层 Lead 无 parentSession）。
function isTeammate(ctx, agent) {
  try {
    const teams = (typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined) ?? ctx.agentTeams;
    const m = teams?.tryMembership?.(agent);
    if (m?.role === 'teammate') return true;
    if (m?.role === 'lead') return false;
  } catch {}
  try {
    const h = agent?.session?.header;
    return h?.parentSession !== undefined && h?.parentSession !== null;
  } catch { return false; }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// 与 @deepseek-ai/dsh-llm 的 createUserMessage 同构：带唯一 id 的不可变 user 消息。
// source.kind 必须显式给（否则派生历史里会被当成普通用户提问渲染）。
function notice(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...GUARD_SOURCE, form: 'notice', summary },
  });
}

// 六步凭证的字段完整性校验（形式完整性，不判断内容质量）。
// 任一子任务 passed=false 或 concluded!==true 都视为「任务未圆满完成」，凭证不予登记。
function missing(args) {
  const out = [];
  if (!args || typeof args !== 'object') return ['整个凭证'];
  const c = args.complexity;
  if (!c || typeof c !== 'object') out.push('complexity（复杂度前置判定）');
  else {
    if (!Array.isArray(c.triggered)) out.push('complexity.triggered（命中的判定条目）');
    if (typeof c.safetyKeyword !== 'boolean') out.push('complexity.safetyKeyword（安全关键词）');
    if (c.verdict !== '复杂' && c.verdict !== '简单') out.push('complexity.verdict（复杂/简单）');
  }
  if (!['light', 'standard', 'mixed'].includes(args.path)) out.push('path（light/standard/mixed）');
  const s = args.steps;
  if (!s || typeof s !== 'object') out.push('steps（六步逐项 + 答复）');
  else {
    // 新六步要求「每一步的思考结果都输出」，因此七项状态全部必须为 done，不接受 skipped。
    for (const k of ['what', 'why', 'how', 'divide', 'execute', 'audit', 'answer']) {
      if (s[k] !== 'done') out.push('steps.' + k + ' 必须为 done（每一步都要输出，不可 skipped）');
    }
  }
  if (!Array.isArray(args.subtasks) || args.subtasks.length === 0)
    out.push('subtasks（第 4 步子任务逐项执行与审计结果，至少 1 项）');
  else {
    for (let i = 0; i < args.subtasks.length; i++) {
      const t = args.subtasks[i];
      if (!t || typeof t !== 'object' || typeof t.task !== 'string' ||
          typeof t.result !== 'string' || typeof t.audit !== 'string' || typeof t.passed !== 'boolean')
        out.push('subtasks[' + i + ']（task/result/audit/passed）');
      else if (!t.passed)
        out.push('subtasks[' + i + '].passed=false（子任务审计未通过，须带审计结果回第 1 步循环）');
    }
  }
  if (!Array.isArray(args.audit) || args.audit.length !== 8 || !args.audit.every((v) => v === true))
    out.push('audit（8 条审计清单须全部为 true）');
  if (args.concluded !== true) out.push('concluded（任务圆满完成才为 true）');
  return out;
}

function receiptTool(state) {
  return {
    name: 'six_step_receipt',
    description:
      '六步思考执行凭证：1是什么→2为什么→3怎么做→4任务划分→5执行→6审计，每步输出且第 6 步审计全部通过后、' +
      '给出最终答复之前必须调用。须完整填写「①复杂度前置判定 / ②路径选择 / ③六步逐项状态 / ' +
      '④第 4 步子任务逐项执行与审计结果 / ⑤第 6 步审计 8 条清单 / ⑥任务是否圆满完成」。' +
      '任一子任务 passed=false 或 concluded 不为 true 都会被 guard 拦回重做（须带审计结果回第 1 步循环，直到圆满完成）。' +
      '这是内部凭证，不会作为答复正文呈现；每一步都要输出，七项状态全部必须 done（不可 skipped）。',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['complexity', 'path', 'steps', 'subtasks', 'audit', 'concluded'],
      properties: {
        complexity: {
          type: 'object', additionalProperties: false,
          required: ['triggered', 'safetyKeyword', 'verdict'],
          properties: {
            triggered: { type: 'array', items: { type: 'string' } },
            safetyKeyword: { type: 'boolean' },
            verdict: { type: 'string', enum: ['复杂', '简单'] },
          },
        },
        path: { type: 'string', enum: ['light', 'standard', 'mixed'] },
        steps: {
          type: 'object', additionalProperties: false,
          required: ['what', 'why', 'how', 'divide', 'execute', 'audit', 'answer'],
          properties: {
            what: { type: 'string', enum: ['done', 'skipped'] },
            why: { type: 'string', enum: ['done', 'skipped'] },
            how: { type: 'string', enum: ['done', 'skipped'] },
            divide: { type: 'string', enum: ['done', 'skipped'] },
            execute: { type: 'string', enum: ['done', 'skipped'] },
            audit: { type: 'string', enum: ['done', 'skipped'] },
            answer: { type: 'string', enum: ['done', 'skipped'] },
          },
        },
        subtasks: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['task', 'result', 'audit', 'passed'],
            properties: {
              task: { type: 'string' },
              result: { type: 'string' },
              audit: { type: 'string' },
              passed: { type: 'boolean' },
            },
          },
        },
        audit: { type: 'array', items: { type: 'boolean' } },
        concluded: { type: 'boolean' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['accepted', 'message'],
        properties: { accepted: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    presentCall: () => ({ card: 'generic', title: '六步凭证', kind: 'other', rawInput: '已提交六步执行凭证' }),
    execute(args, exec) {
      const key = keyOf(exec?.agent);
      const st = state.get(key) ?? { receipt: null, retries: 0 };
      state.set(key, st);
      const miss = missing(args);
      if (miss.length) {
        st.receipt = null;
        return Promise.resolve({ accepted: false, message: '六步凭证不完整，缺少：' + miss.join('、') + '。补全后重新调用。' });
      }
      st.receipt = args;
      return Promise.resolve({ accepted: true, message: '六步执行凭证已登记，任务圆满完成，允许给出最终答复。' });
    },
  };
}

export function apply(ctx) {
  const state = new WeakMap();
  const warn = (msg) => { try { ctx.logger?.warn?.('[six-step-guard] ' + msg); } catch {} };

  ctx.tools.register(receiptTool(state));

  // 真实用户输入开启新一轮：清空上一轮的凭证与重做计数。注入的拦截消息
  // source.kind = six-step-guard，不会触发重置，重做次数得以跨 step 保留。
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user')) {
      const fresh = () => ({ receipt: null, retries: 0 });
      state.set(keyOf(agent), fresh());
      state.set(FALLBACK, fresh());
    }
    return next();
  });

  // 唯一能在「答完」之后拒绝收工的缝（serial，await 后才提交 turn 边界）。
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      // 复杂任务下派生的六步 teammate 只做单步，豁免强制凭证（顶层 Lead 仍必须提交）。
      if (isTeammate(ctx, agent)) return;
      const key = keyOf(agent);
      const st = state.get(key) ?? { receipt: null, retries: 0 };
      state.set(key, st);
      // 兜底：工具执行时 exec.agent 缺失会把凭证记在 FALLBACK 槽，这里补认领。
      if (!st.receipt && key !== FALLBACK) {
        const fb = state.get(FALLBACK);
        if (fb?.receipt) { st.receipt = fb.receipt; fb.receipt = null; }
      }
      if (st.receipt) { st.receipt = null; st.retries = 0; return; }
      // 无重做次数上限：缺凭证就一直拦回，直到提交完整凭证才允许收工（与方法论循环对齐）。
      st.retries += 1;
      agent.steer(notice(
        '【六步思考 · 执行完整性拦截】你在给出最终答复之前没有调用 six_step_receipt 提交完整凭证，本轮不允许收工。' +
        '请按六步思考铁律重新完整走一遍并逐步输出：①复杂度前置判定 → ②路径选择 → ' +
        '1是什么 → 2为什么 → 3怎么做（执行方案）→ 4任务划分（拆成简单子任务）→ ' +
        '5执行（给出每个子任务的执行结果）→ 6审计（给出每个子任务的审计结果，8 条清单逐项勾选）。' +
        '若审计不满足，带审计结果回第 1 步循环，直到任务圆满完成；' +
        '然后在最终答复前调用 six_step_receipt 把每一环结果填全（subtasks 逐项 passed=true、concluded=true）。' +
        '这是第 ' + st.retries + ' 次拦截（无次数上限，直到任务圆满完成）。',
        'six-step receipt required · retry ' + st.retries
      ));
    } catch (error) {
      warn('turn-stopping handler error: ' + (error?.message ?? String(error)));
    }
  });
}
