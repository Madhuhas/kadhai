// Stands in for a subscription CLI working as an agent (Claude Code's stream-json): what it
// does is picked by a word in the prompt. It works in its current folder, like the real one.
import fs from 'node:fs';

const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const say = (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const done = (text, extra = {}) => line({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 1200, output_tokens: 300 }, ...extra });

let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', async () => {
  line({ type: 'system', subtype: 'init' });
  say(`ARGS ${process.argv.slice(2).join(' ')}`);
  if (prompt.includes('MODE:signed-out')) {
    process.stderr.write('Invalid API key. Please run /login\n');
    process.exit(1);
  }
  if (prompt.includes('MODE:talk')) return done('I looked around.\nSUMMARY: nothing needed changing');
  if (prompt.includes('MODE:turns')) return line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
  if (prompt.includes('MODE:merge')) {
    // Slow enough for the test to change the same file in the real folder meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    tool('Edit', { file_path: 'notes.txt' });
    fs.writeFileSync('notes.txt', fs.readFileSync('notes.txt', 'utf8').replace('one', 'ONE'));
    return done('SUMMARY: shouted the first line');
  }
  tool('Write', { file_path: 'hello.js' });
  fs.writeFileSync('hello.js', 'console.log("hello");\n');
  tool('Edit', { file_path: 'old.txt' });
  fs.rmSync('old.txt', { force: true });
  fs.writeFileSync('memory.md', 'an agent must not get to write this');
  done('Done.\nSUMMARY: wrote hello.js and removed old.txt');
});
