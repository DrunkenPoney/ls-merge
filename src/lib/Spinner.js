'use strict';
const {isAsyncFunction} = require("./Utils");
const chalk             = require('chalk');
const cliCursor         = require('cli-cursor');
const cliSpinners       = require('cli-spinners');
const logSymbols        = require('log-symbols');
const stripAnsi         = require('strip-ansi');
const wcwidth           = require('wcwidth');
const _                 = require('lodash');
const TEXT              = Symbol('text');

const COLORS = Object.freeze({
    default: chalk.cyan,
    success: chalk.green,
    fail: chalk.red.bold,
    info: chalk.blue,
    warning: chalk.yellow,
    error: chalk.red.bold
});


class Spinner {
    constructor(options) {
        if (typeof options === 'string') {
            options = {
                text: options
            };
        }
        
        const sp = (options = options || {}).spinner;
        this.spinner = typeof sp === 'object' && sp != null ? sp : (process.platform === 'win32'
                                                                    ? cliSpinners.line
                                                                    : (cliSpinners[sp] || cliSpinners.dots)); // eslint-disable-line no-nested-ternary
        
        if (this.spinner.frames == null) {
            throw new Error('Spinner must define `frames`');
        }
        
        this.color      = options.color || COLORS.default;
        this.hideCursor = options.hideCursor == null || Boolean(options.hideCursor);
        this.interval   = options.interval || this.spinner.interval || 100;
        this.stream     = options.stream || process.stderr;
        this.id         = null;
        this.frameIndex = 0;
        this.isEnabled  = options.isEnabled !== undefined ? Boolean(options.isEnabled)
                                                          : (this.stream && this.stream.isTTY && !process.env.CI);
        this.lastResult = null;
        
        // Set *after* `this.stream`
        this.text         = options.text || '';
        this.linesToClear = 0;
    }
    
    get text() {
        return this[TEXT];
    }
    
    set text(value) {
        this[TEXT]     = value;
        const columns  = this.stream.columns || 80;
        this.lineCount = stripAnsi('--' + value).split('\n').reduce((count, line) => {
            return count + Math.max(1, Math.ceil(wcwidth(line) / columns));
        }, 0);
    }
    
    get isSpinning() {
        return this.id !== null;
    }
    
    frame() {
        const {frames} = this.spinner;
        let frame      = frames[this.frameIndex];
        
        if (this.color in chalk) {
            frame = chalk[this.color](frame);
        } else if (this.color) {
            frame = this.color(frame);
        }
        
        this.frameIndex = ++this.frameIndex % frames.length;
        
        return frame + ' ' + this.text;
    }
    
    clear() {
        if (!this.isEnabled || !this.stream.isTTY) {
            return this;
        }
        
        for (let i = 0; i < this.linesToClear; i++) {
            if (i > 0) {
                this.stream.moveCursor(0, -1);
            }
            this.stream.clearLine();
            this.stream.cursorTo(0);
        }
        this.linesToClear = 0;
        
        return this;
    }
    
    render() {
        this.clear();
        this.stream.write(this.frame());
        this.linesToClear = this.lineCount;
        return this;
    }
    
    start(text) {
        if (text) {
            this.text = text;
        }
        
        if (!this.isEnabled) {
            this.stream.write(`- ${this.text}\n`);
            return this;
        }
        
        if (this.isSpinning) {
            return this;
        }
        
        if (this.hideCursor) {
            cliCursor.hide(this.stream);
        }
        
        this.render();
        this.id = setInterval(this.render.bind(this), this.interval);
        
        return this;
    }
    
    stop() {
        if (!this.isEnabled) {
            return this;
        }
        
        clearInterval(this.id);
        this.id         = null;
        this.frameIndex = 0;
        this.clear();
        if (this.hideCursor) {
            cliCursor.show(this.stream);
        }
        
        return this;
    }
    
    succeed(opts = {}) {
        if (typeof opts === 'string') {
            opts = {text: opts};
        }
        return this.stopAndPersist(_.merge({
            symbol: logSymbols.success,
            color: COLORS.success
        }, opts));
    }
    
    fail(opts = {}) {
        if (typeof opts === 'string') {
            opts = {text: opts};
        }
        return this.stopAndPersist(_.merge({symbol: logSymbols.error, color: COLORS.fail}, opts));
    }
    
    warn(opts = {}) {
        if (typeof opts === 'string') {
            opts = {text: opts};
        }
        return this.stopAndPersist(_.merge({
            symbol: logSymbols.warning,
            color: COLORS.warning
        }, opts));
    }
    
    info(opts = {}) {
        if (typeof opts === 'string') {
            opts = {text: opts};
        }
        return this.stopAndPersist(_.merge({symbol: logSymbols.info, color: COLORS.info}, opts));
    }
    
    stopAndPersist(opts) {
        this.stop();
        opts = _.merge({text: this.text, symbol: ' \u{02008}', color: COLORS.default}, opts || {});
        this.stream.write(opts.symbol + '\u{02008}' + (opts.color in chalk ? chalk[opts.color]
                                                                           : opts.color)(opts.text + '\n'));
        return this;
    }
}

module.exports         = (...opts) => new Spinner(...opts);
module.exports.Spinner = Spinner;
module.exports.promise = async (action, options, {success, failure}) => {
    if (!(action instanceof Promise || isAsyncFunction(action))) {
        throw new TypeError('Parameter `action` must be a Promise or an async function');
    }
    
    const spinner = new Spinner(options).start();
    if (isAsyncFunction(action)) {
        try {
            spinner.lastResult = await action();
            spinner.succeed((success != null && String(success)) || spinner.lastResult);
        } catch (err) {
            spinner.fail((failure != null && String(failure)) || (spinner.lastResult = err).message);
        }
    } else {
        action.then(result => {
            spinner.succeed((success != null && String(success)) || (spinner.lastResult = result));
        }).catch(err => {
            spinner.fail((failure != null && String(failure)) || (spinner.lastResult = err).message);
        });
    }
    
    return spinner;
};
