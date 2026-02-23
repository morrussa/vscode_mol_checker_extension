// extension.js
const vscode = require('vscode');

/**
 * 辅助类：负责扫描和管理子事件文件(.mol_sub)的索引
 */
class SubEventIndexer {
    constructor() {
        this.index = {}; // { "!Tag": { uri: Uri, line: number } }
    }

    async buildIndex() {
        this.index = {};
        const files = await vscode.workspace.findFiles('**/*.mol_sub');
        const promises = files.map(async (fileUri) => {
            try {
                const document = await vscode.workspace.openTextDocument(fileUri);
                this.parseDocument(document);
            } catch (err) {
                console.error(`解析子文件失败: ${fileUri.fsPath}`, err);
            }
        });
        await Promise.all(promises);
    }

    parseDocument(document) {
        const text = document.getText();
        const lines = text.split('\n');
        const uri = document.uri;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('!')) {
                this.index[trimmed] = { uri: uri, line: i, text: lines[i] };
            }
        }
    }

    getDefinition(tag) { return this.index[tag]; }
    getAllTags() { return Object.keys(this.index); }
}

const subEventIndexer = new SubEventIndexer();

// -------------------------------------------------------------------------
// 语义高亮提供器
// -------------------------------------------------------------------------
const tokenTypes = ['class', 'interface', 'struct', 'keyword', 'function', 'variable', 'string', 'number', 'operator', 'macro', 'enumMember'];
const tokenModifiers = ['declaration', 'documentation'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

const semanticTokensProvider = {
    provideDocumentSemanticTokens(document) {
        const tokensBuilder = new vscode.SemanticTokensBuilder(legend);
        const text = document.getText();
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('//')) continue;

            // 获取行首位置（考虑缩进）
            const lineStartOffset = line.indexOf(trimmed);

            // 高亮 <!...> 变量
            const varMatches = [...line.matchAll(/<!([^>]+)>/g)];
            varMatches.forEach(match => {
                const start = line.indexOf(match[0]);
                tokensBuilder.push(new vscode.Range(i, start, i, start + match[0].length), 'variable');
            });

            // O - 对话块 -> class
            if (trimmed.match(/^O[\w_]+/)) {
                const match = trimmed.match(/^(O[\w_]+)/);
                if (match) {
                    tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + match[0].length), 'class', ['declaration']);
                }
            }
            // A - 锚点 -> interface
            else if (trimmed.match(/^A[\w_]+/)) {
                const match = trimmed.match(/^(A[\w_]+)/);
                if (match) {
                    tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + match[0].length), 'interface', ['declaration']);
                }
            }
            // !Tag - 子事件 -> macro
            else if (trimmed.startsWith('!')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + trimmed.length), 'macro');
            }
            // E - 结束 -> keyword
            else if (trimmed.match(/^E\b/)) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'keyword');
            }
            // G - 跳转 -> function
            else if (trimmed.startsWith('G')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'function');
            }
            // T - 文本 -> string (只高亮 T 字符)
            else if (trimmed.startsWith('T')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'string');
            }
            // N - 名字 -> variable
            else if (trimmed.startsWith('N')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'variable');
            }
            // C - 表情 -> enumMember
            else if (trimmed.startsWith('C')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'enumMember');
            }
            // M, S, B, F, I -> function
            else if (trimmed.match(/^[MSBFI]\b/)) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'function');
            }
            // 选项控制 -> operator
            else if (trimmed.startsWith('>>')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 2), 'operator');
            }
            else if (trimmed.startsWith('<<')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 2), 'operator');
            }
            else if (trimmed.startsWith('>')) {
                tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + 1), 'operator');
            }
            // 条件判断 ?IF -> keyword
            else if (trimmed.match(/^\?(IF|ELSE|ELSIF|ENDIF|END)/i)) {
                const match = trimmed.match(/^(\?\w+)/);
                if (match) {
                    tokensBuilder.push(new vscode.Range(i, lineStartOffset, i, lineStartOffset + match[0].length), 'keyword');
                }
            }
        }
        return tokensBuilder.build();
    }
};

function activate(context) {
    console.log('Dialogue 语言扩展已激活');
    vscode.window.showInformationMessage('Dialogue 语言扩展已激活');

    // --- 0. 初始化 ---
    subEventIndexer.buildIndex();
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.path.endsWith('.mol_sub')) subEventIndexer.buildIndex();
        })
    );

    // --- 0.1 注册语义高亮 ---
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'dialogue', scheme: 'file' },
            semanticTokensProvider,
            legend
        )
    );

    // --- 1. 诊断功能 ---
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('dialogue');
    const updateDiagnostics = (document) => {
        if (document.languageId !== 'dialogue') return;
        if (document.uri.path.endsWith('.mol_sub')) {
            diagnosticCollection.set(document.uri, []);
            return;
        }

        const diagnostics = [];
        const text = document.getText();
        const lines = text.split('\n');
        const oBlocks = {}; const aAnchors = {}; const ifStack = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('O')) {
                const name = trimmed.substring(1).trim();
                if (name) {
                    if (oBlocks[name] !== undefined) {
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `重复的对话块(O)索引 [${name}]`, vscode.DiagnosticSeverity.Error));
                    } else { oBlocks[name] = i; }
                }
            }
            if (trimmed.startsWith('A')) {
                const name = trimmed.substring(1).trim();
                if (name) {
                    if (aAnchors[name] !== undefined) {
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `重复的锚点(A)索引 [${name}]`, vscode.DiagnosticSeverity.Error));
                    } else { aAnchors[name] = i; }
                }
            }
            if (trimmed.startsWith('!')) {
                if (!subEventIndexer.getDefinition(trimmed)) {
                    diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `未找到子事件标签 [${trimmed}]`, vscode.DiagnosticSeverity.Error));
                }
            }
            if (trimmed.match(/^\?IF(\s|$)/i)) ifStack.push({ line: i });
            else if (trimmed.match(/^\?ENDIF$/i) || trimmed.match(/^\?END$/i)) {
                if (ifStack.length > 0) ifStack.pop();
                else diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `多余的 ?ENDIF`, vscode.DiagnosticSeverity.Warning));
            }
        }
        while (ifStack.length > 0) {
            const unclosed = ifStack.pop();
            diagnostics.push(new vscode.Diagnostic(new vscode.Range(unclosed.line, 0, unclosed.line, lines[unclosed.line].length), `未闭合的条件块`, vscode.DiagnosticSeverity.Error));
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]; const trimmed = line.trim();
            if (trimmed.startsWith('G')) {
                let targetName, type;
                if (trimmed.startsWith('GO')) {
                    targetName = trimmed.substring(2).trim();
                    type = 'O';
                } else if (trimmed.startsWith('GA')) {
                    targetName = trimmed.substring(2).trim();
                    type = 'A';
                } else {
                    targetName = trimmed.substring(1).trim();
                    type = 'A';   // 单 G 保持原逻辑，跳转到锚点
                }
                if (targetName) {
                    if (type === 'O' && !oBlocks[targetName]) {
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `找不到对话块 O${targetName}`, vscode.DiagnosticSeverity.Warning));
                    } else if (type === 'A' && !aAnchors[targetName]) {
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, 0, i, line.length), `找不到锚点 A${targetName}`, vscode.DiagnosticSeverity.Warning));
                    }
                }
            }
            if (trimmed.startsWith('>')) {
                const parts = trimmed.match(/^>([^#]*)#(.+)/);
                if (parts && parts[2]) {
                    const targetName = parts[2].trim();
                    if (!oBlocks[targetName]) {
                        const idx = trimmed.indexOf('#');
                        const startChar = line.indexOf(trimmed) + idx;
                        diagnostics.push(new vscode.Diagnostic(new vscode.Range(i, startChar, i, startChar + targetName.length + 1), `找不到对话块 O${targetName}`, vscode.DiagnosticSeverity.Warning));
                    }
                }
            }
        }
        diagnosticCollection.set(document.uri, diagnostics);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => updateDiagnostics(e.document)),
        vscode.workspace.onDidOpenTextDocument(doc => updateDiagnostics(doc)),
        vscode.workspace.onDidSaveTextDocument(doc => updateDiagnostics(doc)),
        diagnosticCollection
    );
    if (vscode.window.activeTextEditor) updateDiagnostics(vscode.window.activeTextEditor.document);

    // --- 2. 定义跳转 ---
    const definitionProvider = vscode.languages.registerDefinitionProvider({ language: 'dialogue', scheme: 'file' }, {
        provideDefinition(document, position, token) {
            const line = document.lineAt(position.line).text;
            const trimmed = line.trim();
            if (trimmed.startsWith('!')) {
                const def = subEventIndexer.getDefinition(trimmed);
                if (def) return new vscode.Location(def.uri, new vscode.Position(def.line, 0));
            }
            if (trimmed.startsWith('G') && position.character >= line.indexOf(trimmed) + 1) {
                let targetName;
                let searchType; // 'O' 或 'A'
                if (trimmed.startsWith('GO')) {
                    targetName = trimmed.substring(2).trim();
                    searchType = 'O';
                } else if (trimmed.startsWith('GA')) {
                    targetName = trimmed.substring(2).trim();
                    searchType = 'A';
                } else {
                    targetName = trimmed.substring(1).trim();
                    searchType = 'A';
                }
                if (targetName) {
                    for (let i = 0; i < document.lineCount; i++) {
                        const defLine = document.lineAt(i).text.trim();
                        if (searchType === 'O' && defLine.startsWith('O') && defLine.substring(1).trim() === targetName) {
                            return new vscode.Location(document.uri, new vscode.Position(i, 0));
                        }
                        if (searchType === 'A' && defLine.startsWith('A') && defLine.substring(1).trim() === targetName) {
                            return new vscode.Location(document.uri, new vscode.Position(i, 0));
                        }
                    }
                }
            }
            if (trimmed.startsWith('>') && trimmed.includes('#')) {
                const idx = trimmed.indexOf('#');
                if (position.character - line.indexOf(trimmed) > idx) {
                    const targetName = trimmed.substring(idx + 1).trim();
                    for (let i = 0; i < document.lineCount; i++) {
                        const defLine = document.lineAt(i).text.trim();
                        if (defLine.startsWith('O') && defLine.substring(1).trim() === targetName) return new vscode.Location(document.uri, new vscode.Position(i, 0));
                    }
                }
            }
            return null;
        }
    });
    context.subscriptions.push(definitionProvider);

    // --- 3. 自动补全 (更新 B 命令格式以支持 Lua 表参数) ---
    const completionProvider = vscode.languages.registerCompletionItemProvider({ language: 'dialogue' }, {
        provideCompletionItems(document, position, token, context) {
            const items = [];
            const commands = [
                { prefix: 'O', body: 'O${1:name}\n    ${2:content}\nE', doc: '对话块' },
                { prefix: 'T', body: 'T${1:文本内容}', doc: '对话文本，支持 <!$var> 变量' },
                { prefix: 'N', body: 'N${1:名字}', doc: '角色名，支持 <!$var> 变量' },
                { prefix: 'C', body: 'C${1:表情名}', doc: '角色表情' },
                { prefix: 'E', body: 'E', doc: '结束块' },
                { prefix: 'G', body: 'G${1:锚点名}', doc: '跳转到锚点' },
                { prefix: 'A', body: 'A${1:锚点名}', doc: '定义锚点' },
                { prefix: 'M', body: 'M($${1:var} = ${2:value})', doc: '修改存档变量' },
                { prefix: 'S', body: 'S${1:速度数值}', doc: '打字速度' },
                { prefix: 'B', body: 'B ${1:url} ${2:message} {${3:params}}', doc: '广播消息，参数使用Lua表格式，如 {key=value}，支持 <!$var> 变量' },
                { prefix: 'F', body: 'F(${1:func_name}, ${2:param})', doc: '调用函数' },
                { prefix: '>', body: '>${1:选项文本}#${2:目标块名}', doc: '普通选项' },
                { prefix: '>>', body: '>>${1:选项文本}#${2:即时命令}', doc: '即时执行选项' },
                { prefix: '<<', body: '<<', doc: '结束选项块 (用于选项后继续剧情)' },
            ];
            commands.forEach(cmd => {
                const item = new vscode.CompletionItem(cmd.prefix, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(cmd.body);
                item.documentation = cmd.doc;
                items.push(item);
            });
            
            const ifItem = new vscode.CompletionItem('?IF', vscode.CompletionItemKind.Snippet);
            ifItem.insertText = new vscode.SnippetString('?IF (${1:condition})\n    ${2:content}\n?ENDIF');
            items.push(ifItem);

            subEventIndexer.getAllTags().forEach(tag => {
                const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Reference);
                item.insertText = tag; 
                item.documentation = `跳转到子事件: ${tag}`;
                items.push(item);
            });
            return items;
        }
    }, '!', 'O', 'T', 'N', 'C', 'E', 'G', 'A', 'M', 'S', 'B', 'F', '>', '?');
    context.subscriptions.push(completionProvider);

    // --- 4. 代码折叠 ---
    const foldingProvider = vscode.languages.registerFoldingRangeProvider({ language: 'dialogue', scheme: 'file' }, {
        provideFoldingRanges(document, context, token) {
            const ranges = [];
            const lines = document.getText().split('\n');
            const lineCount = lines.length;
            const stack = []; // 用于 O 和 IF
            
            const isSubFile = document.uri.path.endsWith('.mol_sub');
            let subEventStart = -1;

            // 辅助函数：判断是否为选项行（支持 ?(...) 前缀）
            const isOptionLine = (lineText) => {
                const t = lineText.trim();
                if (t.startsWith('>') || t.startsWith('>>')) return true;
                // 检查带条件的选项 ?(...) >...
                if (t.startsWith('?')) {
                    const match = t.match(/^\?\([^)]*\)\s*>/);
                    if (match) return true;
                }
                return false;
            };

            for (let i = 0; i < lineCount; i++) {
                const line = lines[i];
                const trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith('//')) continue;

                // 1. .mol_sub 的 !Tag 折叠
                if (isSubFile && trimmed.startsWith('!')) {
                    if (subEventStart !== -1 && i - 1 >= subEventStart) ranges.push(new vscode.FoldingRange(subEventStart, i - 1));
                    subEventStart = i;
                }

                // 2. O 块折叠
                if (trimmed.match(/^O[\w_]+/)) {
                    // 如果遇到新的 O，强制关闭上一个未关闭的 O（容错）
                    for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'O') {
                            ranges.push(new vscode.FoldingRange(stack[j].start, i - 1));
                            stack.splice(j, 1); break;
                        }
                    }
                    stack.push({ type: 'O', start: i });
                }
                
                // 3. ?IF 块折叠
                else if (trimmed.match(/^\?IF(\s|$)/i)) {
                    stack.push({ type: 'IF', start: i });
                }

                // 4. 结束判断
                // E 结束 O
                if (trimmed.match(/^E\b/)) {
                    for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'O') {
                            ranges.push(new vscode.FoldingRange(stack[j].start, i));
                            stack.splice(j, 1); break;
                        }
                    }
                }
                // G 结束 O (G 相当于跳转结束)
                else if (trimmed.startsWith('G')) {
                    for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'O') {
                            ranges.push(new vscode.FoldingRange(stack[j].start, i));
                            stack.splice(j, 1); break;
                        }
                    }
                }
                // << 结束选项块
                else if (trimmed.startsWith('<<')) {
                     for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'O') {
                            ranges.push(new vscode.FoldingRange(stack[j].start, i));
                            stack.splice(j, 1); break;
                        }
                    }
                }
                // > 选项组结束 O
                else if (isOptionLine(trimmed)) {
                    // 找到 O 块
                    let oIdx = -1;
                    for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'O') { oIdx = j; break; }
                    }

                    if (oIdx !== -1) {
                        // 检查下一行是否还是选项。如果不是，则当前行是最后一项选项，闭合 O 块
                        let nextIsOption = false;
                        if (i + 1 < lineCount) {
                            // 向前查找非空行
                            for (let k = i + 1; k < lineCount; k++) {
                                const nextTrim = lines[k].trim();
                                if (nextTrim === '' || nextTrim.startsWith('//')) continue;
                                // 如果遇到 <<，也视为选项组结束
                                if (nextTrim.startsWith('<<')) { nextIsOption = false; break; }
                                nextIsOption = isOptionLine(nextTrim);
                                break;
                            }
                        }

                        if (!nextIsOption) {
                            // 下一行不是选项，说明选项组在此结束，O块也在此结束
                            ranges.push(new vscode.FoldingRange(stack[oIdx].start, i));
                            stack.splice(oIdx, 1);
                        }
                    }
                }

                // ?ENDIF 结束 IF
                if (trimmed.match(/^\?ENDIF$/i) || trimmed.match(/^\?END$/i)) {
                    for (let j = stack.length - 1; j >= 0; j--) {
                        if (stack[j].type === 'IF') {
                            ranges.push(new vscode.FoldingRange(stack[j].start, i));
                            stack.splice(j, 1); break;
                        }
                    }
                }
            }

            // 文件结束，关闭未闭合的块
            while (stack.length > 0) {
                const top = stack.pop();
                ranges.push(new vscode.FoldingRange(top.start, lineCount - 1));
            }
            if (isSubFile && subEventStart !== -1) ranges.push(new vscode.FoldingRange(subEventStart, lineCount - 1));

            return ranges;
        }
    });
    context.subscriptions.push(foldingProvider);

    // --- 5. 格式化命令（已修改以支持选项附属行不缩进） ---
    const formatDisposable = vscode.commands.registerCommand('dialogue.formatIndent', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'dialogue') return;

        const document = editor.document;
        const lines = document.getText().split('\n');
        const newLines = [];
        let insideOBlock = false;
        let inOptionSuffix = false; // 是否处于选项附属区域（选项行之后，下一个选项或 << 之前）

        // 辅助函数：判断是否为选项行
        const isOptionLineFormat = (lineText) => {
            const t = lineText.trim();
            if (t.startsWith('>') || t.startsWith('>>')) return true;
            if (t.startsWith('?')) return !!t.match(/^\?\([^)]*\)\s*>/);
            return false;
        };

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            const trimmed = line.trim();

            // 处理空行和注释：保持原样，不改变状态
            if (trimmed === '' || trimmed.startsWith('//')) {
                newLines.push(line);
                continue;
            }

            // O 开始
            if (trimmed.match(/^O[\w_]+/)) {
                insideOBlock = true;
                inOptionSuffix = false; // 进入新的 O 块，重置附属状态
                newLines.push(line); // O 行本身不缩进
                continue;
            }

            // E 结束
            if (trimmed.match(/^E\b/)) {
                insideOBlock = false;
                inOptionSuffix = false;
                newLines.push(line);
                continue;
            }

            // 如果在 O 块外，直接保留原行
            if (!insideOBlock) {
                newLines.push(line);
                continue;
            }

            // 以下处理在 O 块内的行

            // 选项行
            if (isOptionLineFormat(trimmed)) {
                // 选项行本身缩进
                newLines.push('    ' + line.trimStart());
                inOptionSuffix = true; // 接下来的行（直到下一个选项或 <<）属于附属区域，不缩进
                continue;
            }

            // << 行
            if (trimmed.startsWith('<<')) {
                // << 不缩进，并结束附属区域
                newLines.push(line.trimStart());
                inOptionSuffix = false;
                continue;
            }

            // 其他命令（包括 G、T、N、C、M、S、B、F、I、A 等）
            if (inOptionSuffix) {
                // 在选项附属中，所有行都不缩进
                newLines.push(line.trimStart());
            } else {
                // 不在附属中，缩进
                newLines.push('    ' + line.trimStart());
            }
        }

        const fullRange = new vscode.Range(0, 0, document.lineCount - 1, lines[lines.length - 1].length);
        editor.edit(editBuilder => {
            editBuilder.replace(fullRange, newLines.join('\n'));
        }).then(success => {
            if (success) vscode.window.showInformationMessage('已为 O 块添加缩进');
        });
    });

    const cleanDisposable = vscode.commands.registerCommand('dialogue.cleanIndent', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'dialogue') return;

        const document = editor.document;
        const lines = document.getText().split('\n');
        const newLines = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.startsWith('    ')) {
                newLines.push(line.substring(4));
            } else {
                newLines.push(line);
            }
        }

        const fullRange = new vscode.Range(0, 0, document.lineCount - 1, lines[lines.length - 1].length);
        editor.edit(editBuilder => {
            editBuilder.replace(fullRange, newLines.join('\n'));
        }).then(success => {
            if (success) vscode.window.showInformationMessage('已去除缩进');
        });
    });

    context.subscriptions.push(formatDisposable, cleanDisposable);
}

function deactivate() {}

module.exports = { activate, deactivate };