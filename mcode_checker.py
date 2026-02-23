import sys
from collections import defaultdict
import re
import datetime
import json

def static_check_dialogue(filename="dialogue.txt"):
    log_filename = f"check_log_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    log_file = open(log_filename, "w", encoding="utf-8")
    
    class Tee:
        def __init__(self, *files):
            self.files = files
        def write(self, text):
            for f in self.files:
                f.write(text)
        def flush(self):
            for f in self.files:
                f.flush()
    
    original_stdout = sys.stdout
    sys.stdout = Tee(original_stdout, log_file)

    print(f"正在检查文件: {filename}\n")
    
    with open(filename, 'r', encoding='utf-8') as f:
        lines = [line.rstrip() for line in f.readlines()]
    
    o_index = {}                    # O块名 -> 行号
    a_index = {}                    # A锚点名 -> 行号
    option_jumps = defaultdict(list)  # 块 -> 选项跳转目标
    g_jumps = defaultdict(list)       # 块 -> G跳转目标
    
    block_has_E = defaultdict(bool)
    block_has_option = defaultdict(bool)
    block_has_G = defaultdict(bool)
    block_closed = defaultdict(bool)   # 块是否已遇到闭合指令（G/>/E）
    
    block_has_conditional = defaultdict(bool)  # 是否有条件（I 或 ?）
    block_has_modify = defaultdict(bool)       # 是否有 M
    
    current_block = None
    previous_block = None
    consecutive_options = 0
    current_option_block = None
    
    all_jumps = defaultdict(list)
    
    pending_anchor = None  # 独立或闭合后后置的 A
    
    # 条件块堆栈
    condition_stack = []
    
    # 用于折叠的块范围
    block_ranges = []
    block_start_line = None
    
    for line_num, raw_line in enumerate(lines, 1):
        line = raw_line.strip()

        if not line:
            if current_block is not None and not block_closed[current_block]:
                print(f" [行 {line_num}]: O{current_block} 块内出现空行")
            continue
        
        # 检测O块开始
        if line.startswith("O"):
            # 记录上一个块的结束
            if current_block is not None and block_start_line is not None:
                block_ranges.append({
                    "name": current_block,
                    "start": block_start_line,
                    "end": line_num - 2  # 上一个块结束于当前行前一行
                })
            
            block_id = line[1:].strip()
            block_start_line = line_num - 1  # 0-based行号
            
            if block_id in o_index:
                print(f"错误 [行 {line_num}]: 重复定义 O 块 '{block_id}'")
            else:
                o_index[block_id] = line_num
                print(f"信息 [行 {line_num}]: 注册 O 块 '{block_id}'")
                
                # 补全 pending A 的顺序流
                if pending_anchor is not None:
                    all_jumps[pending_anchor].append(block_id)
                    print(f"信息 [行 {line_num}]: 添加 A{pending_anchor} → O{block_id} 顺序流")
                    pending_anchor = None
                
                # 默认顺序流
                if previous_block and not (block_has_E[previous_block] or block_has_option[previous_block] or block_has_G[previous_block]):
                    all_jumps[previous_block].append(block_id)
                    print(f"信息: 添加默认顺序流 O{previous_block} → O{block_id} (上一个块未显式闭合)")
                
                if previous_block and not (block_has_E[previous_block] or block_has_option[previous_block] or block_has_G[previous_block]):
                    print(f"警告 [块 O{previous_block} (行 {o_index[previous_block]})]: 未用 E 闭合且无选项/手动G")
                
                previous_block = current_block
                current_block = block_id
                block_closed[current_block] = False
            
            if consecutive_options > 0:
                if consecutive_options == 1:
                    print(f"警告 [块 O{current_option_block or '未知'}]: 只有一个选项")
                consecutive_options = 0
            current_option_block = current_block
        
        # 处理 A 锚点
        elif line.startswith("A"):
            anchor_id = line[1:].strip()
            if not anchor_id:
                print(f"警告 [行 {line_num}]: A指令缺少锚点ID")
                continue
            if anchor_id in a_index:
                print(f"错误 [行 {line_num}]: 重复定义 A 锚点 '{anchor_id}' (原行 {a_index[anchor_id]})")
            else:
                a_index[anchor_id] = line_num
                if current_block is None or block_closed[current_block]:
                    pending_anchor = anchor_id
                    print(f"信息 [行 {line_num}]: 注册独立 A 锚点 '{anchor_id}'")
                else:
                    print(f"信息 [行 {line_num}]: 注册嵌入式 A 锚点 '{anchor_id}'")
        
        # 处理 G 跳转
        elif line.startswith("G"):
            target = line[1:].strip()
            if not target:
                print(f"警告 [行 {line_num}]: G指令缺少目标")
                continue
            if current_block:
                g_jumps[current_block].append(target)
                block_has_G[current_block] = True
                block_closed[current_block] = True
                all_jumps[current_block].append(target)
        
        # 处理选项
        elif line.startswith(">"):
            parts = raw_line[1:].split("#", 1)
            target = parts[1].strip() if len(parts) > 1 else None
            if target and current_block:
                option_jumps[current_block].append(target)
                all_jumps[current_block].append(target)
            consecutive_options += 1
            block_has_option[current_block] = True
            block_closed[current_block] = True
        
        # 处理条件指令
        elif line.startswith("?IF"):
            condition_match = re.match(r"\?IF\s*\((.+)\)\s*$", line)
            if not condition_match:
                print(f"错误 [行 {line_num}]: ?IF 格式错误")
                continue
            condition = condition_match.group(1).strip()
            if "~=" in condition:
                print(f"错误 [行 {line_num}]: 条件中使用 '~=' （请用 '<>'）")
            if current_block is None:
                print(f"错误 [行 {line_num}]: ?IF 出现在 O 块外部")
            elif block_closed[current_block]:
                print(f"错误 [行 {line_num}]: ?IF 出现在块已闭合后")
            else:
                condition_stack.append((current_block, line_num, 'IF'))
            if current_block:
                block_has_conditional[current_block] = True

        elif line.startswith("?ELSIF"):
            condition_match = re.match(r"\?ELSIF\s*\((.+)\)\s*$", line)
            if not condition_match:
                print(f"错误 [行 {line_num}]: ?ELSIF 格式错误")
                continue
            condition = condition_match.group(1).strip()
            if "~=" in condition:
                print(f"错误 [行 {line_num}]: 条件中使用 '~=' （请用 '<>'）")
            if not condition_stack:
                print(f"错误 [行 {line_num}]: ?ELSIF 出现在 ?IF 之外")
            else:
                top_block, top_line, top_type = condition_stack[-1]
                if top_block != current_block:
                    print(f"错误 [行 {line_num}]: ?ELSIF 跨块")
                elif top_type == 'ELSE':
                    print(f"错误 [行 {line_num}]: ?ELSIF 出现在 ?ELSE 之后")
                else:
                    condition_stack[-1] = (top_block, top_line, 'ELSIF')
            if current_block:
                block_has_conditional[current_block] = True

        elif line.startswith("?ELSE"):
            if line.strip() != "?ELSE":
                print(f"错误 [行 {line_num}]: ?ELSE 格式错误")
                continue
            if not condition_stack:
                print(f"错误 [行 {line_num}]: ?ELSE 出现在 ?IF 之外")
            else:
                top_block, top_line, top_type = condition_stack[-1]
                if top_block != current_block:
                    print(f"错误 [行 {line_num}]: ?ELSE 跨块")
                elif top_type == 'ELSE':
                    print(f"错误 [行 {line_num}]: 重复的 ?ELSE")
                else:
                    condition_stack[-1] = (top_block, top_line, 'ELSE')
            if current_block:
                block_has_conditional[current_block] = True

        elif line.startswith("?ENDIF") or line.startswith("?END"):
            if line not in ("?ENDIF", "?END"):
                print(f"错误 [行 {line_num}]: ?ENDIF/?END 格式错误")
                continue
            if not condition_stack:
                print(f"错误 [行 {line_num}]: 多余的 ?ENDIF")
            else:
                top_block, top_line, top_type = condition_stack.pop()
                if top_block != current_block:
                    print(f"错误 [行 {line_num}]: ?ENDIF 闭合跨块")

        # 处理旧的条件格式
        elif line.startswith("?("):
            match = re.match(r"\?\((.+?)\)(.*)", line)
            if not match:
                print(f"错误 [行 {line_num}]: ? 条件格式错误")
                continue
            condition_str, rest = match.groups()
            rest = rest.strip()
            if "~=" in condition_str:
                print(f"错误 [行 {line_num}]: 条件中使用 '~=' （请用 '<>'）")
            if not rest:
                print(f"警告 [行 {line_num}]: ?(条件) 后面没有任何内容")
            elif rest.startswith(">"):
                opt_match = re.match(r">\s*(.+?)(?:\s*#(\w+))?$", rest)
                if not opt_match:
                    print(f"错误 [行 {line_num}]: 条件选项格式不正确")
                else:
                    text, target = opt_match.groups()
                    if target and target not in o_index:
                        print(f"错误 [行 {line_num}]: 条件选项跳转到不存在的 O{target}")
                    block_has_option[current_block] = True
                    block_closed[current_block] = True
            if rest.startswith(">"):
                block_closed[current_block] = True
                block_has_option[current_block] = True
            if current_block:
                block_has_conditional[current_block] = True

        # 处理 E 结束
        elif line.startswith("E"):
            if current_block:
                block_has_E[current_block] = True
                block_closed[current_block] = True

        # 处理 M 修改
        elif line.startswith("M("):
            if current_block:
                block_has_modify[current_block] = True

    # 文件末尾处理
    if pending_anchor is not None:
        print(f"警告: 独立 A{pending_anchor} 后无后续 O 块")
    
    if current_block and not (block_has_E[current_block] or block_has_option[current_block] or block_has_G[current_block]):
        print(f"警告 [块 O{current_block} (行 {o_index[current_block]})]: 文件末尾块未闭合")
    
    # 记录最后一个块的结束
    if current_block is not None and block_start_line is not None:
        block_ranges.append({
            "name": current_block,
            "start": block_start_line,
            "end": len(lines) - 1
        })
    
    # 检查未闭合的条件块
    if condition_stack:
        print("错误: 存在未闭合的条件块:")
        for block, line_num, typ in condition_stack:
            print(f"    未闭合的 {typ} 起始于 O{block} (行 {line_num})")
    
    # 跳转目标检查
    for from_block, targets in g_jumps.items():
        for t in set(targets):
            if t not in a_index:
                print(f"错误 [块 O{from_block} 的 G 指令]: 跳转到不存在的 A 锚点 '{t}'")
    for from_block, targets in option_jumps.items():
        for t in set(targets):
            if t not in o_index:
                print(f"错误 [块 O{from_block} 的选项跳转]: 跳转到不存在的 O 块 '{t}'")
    
    # 控制流分析
    all_nodes = set(o_index.keys()) | set(a_index.keys())
    incoming = defaultdict(set)
    for fb, ts in all_jumps.items():
        for t in ts:
            if t in all_nodes:
                incoming[t].add(fb)
    
    unreachable_o = [b for b in o_index if b not in incoming and b]
    unreachable_a = [a for a in a_index if a not in incoming]
    if unreachable_o:
        print("警告: 可能不可达的 O 块:")
        for b in sorted(unreachable_o):
            print(f"    O{b} (行 {o_index[b]})")
    if unreachable_a:
        print("警告: 可能不可达的 A 锚点:")
        for a in sorted(unreachable_a):
            print(f"    A{a} (行 {a_index[a]})")
    
    dead_ends = [b for b in o_index if not all_jumps[b]]
    if dead_ends:
        print("信息: 死端 O 块:")
        for b in sorted(dead_ends):
            print(f"    O{b} (行 {o_index[b]})")
    
    print(f"\n检查完成！ 共 {len(o_index)} 个 O 块， {len(a_index)} 个 A 锚点。")

    # 输出块范围（用于VS Code折叠）
    print("\n__BLOCK_RANGES__")
    print(json.dumps(block_ranges, ensure_ascii=False))

    sys.stdout = original_stdout
    log_file.close()
    print(f"\n检查完成，完整日志已保存至 {log_filename}")

if __name__ == "__main__":
    filename = sys.argv[1] if len(sys.argv) > 1 else "dialogue.txt"
    static_check_dialogue(filename)