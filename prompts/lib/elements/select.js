'use strict';

const color = require('kleur');
const Prompt = require('./prompt');
const { style, clear, figures } = require('../util');
const { erase, cursor } = require('sisteransi');

/**
 * SelectPrompt Base Element
 * @param {Object} opts Options
 * @param {String} opts.message Message
 * @param {Array} opts.choices Array of choice objects
 * @param {String} [opts.hint] Hint to display
 * @param {Number} [opts.initial] Index of default value
 * @param {Stream} [opts.stdin] The Readable stream to listen to
 * @param {Stream} [opts.stdout] The Writable stream to write readline data to
 */
class SelectPrompt extends Prompt {
  constructor(opts={}) {
    super(opts);
    this.msg = opts.message;
    this.hint = opts.hint || '- Use arrow-keys. Return to submit.';
    this.warn = opts.warn || '- This option is disabled';
    this.cursor = opts.initial || 0;
    this.values = opts.choices.map((v, i) => ({
      title: v && (v.title || v.value || v),
      value: typeof v === 'object' ? v.value : v,
      selected: v && v.selected,
      disabled: v && v.disabled
    }));
    this.value = opts.choices[this.cursor].value;
    this.clear = clear('');
    this.render();
  }

  moveCursor(n) {
    this.cursor = n;
    this.value = this.values[n].value;
    this.fire();
  }

  reset() {
    this.moveCursor(0);
    this.fire();
    this.render();
  }

  abort() {
    this.done = this.aborted = true;
    this.fire();
    this.render();
    this.out.write('\n');
    this.close();
  }

  submit() {
    if (!this.selection.disabled) {
      this.done = true;
      this.aborted = false;
      this.fire();
      this.render();
      this.out.write('\n');
      this.close();
    } else
      this.bell();
  }

  first() {
    this.moveCursor(0);
    this.render();
  }

  last() {
    this.moveCursor(this.values.length - 1);
    this.render();
  }

  up() {
    if (this.cursor === 0) return this.bell();
    this.moveCursor(this.cursor - 1);
    this.render();
  }

  down() {
    if (this.cursor === this.values.length - 1) return this.bell();
    this.moveCursor(this.cursor + 1);
    this.render();
  }

  next() {
    this.moveCursor((this.cursor + 1) % this.values.length);
    this.render();
  }

  _(c, key) {
    if (c === ' ') return this.submit();
  }

  get selection() {
    return this.values[this.cursor];
  }

  render() {
    if (this.closed) return;
    if (this.first) this.out.write(cursor.hide);
    else this.out.write(erase.lines(this.values.length + 1));
    super.render();

    // Print prompt
    this.out.write([
        style.symbol(this.done, this.aborted),
        color.bold(this.msg),
        style.delimiter(false),
        this.done ? this.selection.title : this.selection.disabled
                  ? color.yellow(this.warn) : color.gray(this.hint)
      ].join(' '));

    // Print choices
    if (!this.done) {
      this.out.write(
        '\n' +
          this.values
            .map((v, i) => {
              let title, prefix;
              if (v.disabled) {
                title = this.cursor === i ? color.gray.underline(v.title) : color.strikethrough.gray(v.title);
                prefix = this.cursor === i ? color.bold.gray(figures.pointer) + ' ' : '  ';
              } else {
                title = this.cursor === i ? color.cyan.underline(v.title) : v.title;
                prefix = this.cursor === i ? color.cyan(figures.pointer) + ' ' : '  ';
              }
              return `${prefix} ${title}`;
            })
            .join('\n')
      );
    }
  }
}

module.exports = SelectPrompt;
