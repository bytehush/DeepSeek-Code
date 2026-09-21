# -*- coding: utf-8 -*-
"""context-audit 图表校验器（只读，绝不改写文件）。

存在理由：文档里的柱状图宽度曾经手抄过两次，两次都抄错（一次两条柱用了不同
基线，一次把 33096B 按 1000 折成 33.1K）。人读输出不能当数据源，所以：
  数据源 = npx tsx scripts/context-audit.ts --scenario all --json
  校验   = 本脚本，逐条柱比对「页面里的宽度」与「审计器算出的宽度」

用法：npx tsx scripts/context-audit.ts --scenario all --json | python3 scripts/check-ctx-doc.py
或直接：python3 scripts/check-ctx-doc.py        （自己跑审计器）
退出码 0 = 全部一致；1 = 有柱与数据不符（打印 got/exp）。
"""
import io
import json
import re
import subprocess
import sys

DOC = 'docs/上下文装配与判据.html'
CLS = {
    '人格与准则': 'f-fixed',
    '工具 schema': 'f-schema',
    '环境段': 'f-env',
    '模式段': 'f-mode',
    '内核反馈(一次性)': 'f-fb',
    '历史:用户消息': 'f-user',
    '历史:模型结论': 'f-model',
    '历史:工具结果(可重跑)': 'f-tr',
    '历史:工具结果(一次性)': 'f-tr2',
}
# 渲染顺序 = 装配顺序（system 段 → 临时 system → 历史），与桶定义一致
ORDER = ['人格与准则', '工具 schema', '环境段', '内核反馈(一次性)', '历史:用户消息',
         '历史:模型结论', '历史:工具结果(可重跑)', '历史:工具结果(一次性)']
# 场景 → (所在 <h2> 小节序号, 需要校验的步)
CHARTS = {'explore-then-fix': 1, 'varying-failures': 2}


def norm(t):
    return re.sub(r'\s+', '', t)


def main():
    audit = subprocess.run(
        ['npx', 'tsx', 'scripts/context-audit.ts', '--scenario', 'all', '--json'],
        capture_output=True, text=True)
    if audit.returncode != 0:
        print('审计器运行失败：\n' + audit.stderr[-800:], file=sys.stderr)
        return 2
    rows = {json.loads(l)['scenario']: json.loads(l) for l in audit.stdout.strip().split('\n')}

    s = io.open(DOC, encoding='utf-8').read()
    marks = [m.start() for m in re.finditer(r'<h2>', s)] + [len(s)]
    bad = 0
    checked = 0
    for scn, sec in CHARTS.items():
        blk = s[marks[sec]:marks[sec + 1]]
        mx = max(x['totalBytes'] for x in rows[scn]['steps'])
        for x in rows[scn]['steps']:
            pat = re.compile(
                r'<span class="blab">步%d</span><span class="btrack">(.*?)</span>' % x['step'], re.S)
            m = pat.search(blk)
            if not m:
                continue
            checked += 1
            exp = norm(''.join(
                '<i class="seg %s" style="width:%.2f%%"></i>' % (CLS[n], x['buckets'][n]['bytes'] / mx * 100)
                for n in ORDER if n in x['buckets']))
            got = norm(m.group(1))
            if got != exp:
                bad += 1
                print('MISMATCH %s 步%d（满格 %d B）\n  页面 %s\n  应为 %s' % (scn, x['step'], mx, got, exp))
            else:
                print('ok %s 步%d' % (scn, x['step']))
    print('校验 %d 条柱，%d 条不符' % (checked, bad))
    return 1 if bad or checked == 0 else 0


if __name__ == '__main__':
    sys.exit(main())
