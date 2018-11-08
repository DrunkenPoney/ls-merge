const {promises: fsp, existsSync: exists, lstatSync: stat, readdirSync: readdir} = require('fs');
const {sep, extname, basename, dirname, join, isAbsolute, resolve}               = require('path');
const {copy, remove: rmdir}                                                      = require('fs-extra');
const {createConnection}                                                         = require('mysql');
const {tmpdir}                                                                   = require('os');
const readline                                                                   = require('readline');
const spinner                                                                    = require('./lib/Spinner')();
const prompts                                                                    = require('prompts');
const chalk                                                                      = require('chalk');
const execa                                                                      = require('execa');
const glob                                                                       = require('tiny-glob');
const junk                                                                       = require('junk');
const argv                                                                       = require('yargs')
    .scriptName('merge')
    .usage(`\nMerge one source directory and sub-directories into a directory created from a `
           + `specific tag/version of limesurvey replacing files when the limesurvey's folder already `
           + `exists.\nUSAGE: $0 [-s "./src/dir"]\n       $0 --clean\n       $0 [--junk] [--dots]`)
    .alias('s', ['src', 'source'])
    .alias('c', 'clean')
    .alias('d', ['debug', 'verbose'])
    .alias('j', ['junk', 'include-junk'])
    .alias('a', ['dots', 'include-dots'])
    .group('s', 'Merge arguments:')
    .group(['j', 'a'], 'Prompt arguments:')
    .describe('s', '[OPTIONAL] The source directory from which the content will be merged into the '
                   + 'new limesurvey directory')
    .describe('c', 'Clean temporary files')
    .describe('d', 'Show debug information')
    .describe('j', 'Allow selection of junk files/folders')
    .describe('a', 'Allow selection of folder starting with a period (.)')
    .requiresArg('s')
    .boolean(['d', 'c', 'j', 'a'])
    .string('s')
    .help()
    .argv;

const prefix     = 'limesurvey-';
const repository = 'https://github.com/LimeSurvey/LimeSurvey.git';

function dir(d) {
    return (exists(d) && stat(d).isDirectory() ? d : dirname(d)).replace(/[\\/]?$/, sep);
}

async function mkdir(dir, args) {
    let {parent, pre} = Object.assign({parent: dir, pre: prefix}, args || {});
    return await fsp.mkdtemp(join(parent, pre));
}

async function gitClone(repo, dir) {
    if (typeof repo !== 'string')
        throw new TypeError('repo is not a string');
    console.log(chalk.bold('Target repository: ' + repo));
    spinner.start(`Cloning git repository (${repo})`);
    try {
        let folder           = await mkdir(dir || tmpdir());
        let {stdout, stderr} = await execa('git', ['clone', repo, folder]);
        if (stderr || (stdout && stdout.trim()))
            console.log(chalk.blue(stderr || stdout));
        spinner.succeed('Git repository cloned!');
        return folder;
    } catch (err) {
        console.log('\n' + chalk.yellow(argv.verbose ? err.stack
                                                     : `${err.constructor.name}: ${err.message}`));
        spinner.fail('The git repository could not be cloned!');
        process.exit(1);
    }
}

function getDirectories(dir) {
    if (typeof dir !== 'string')
        return [];
    if (!isAbsolute(dir))
        dir = resolve(process.cwd(), dir);
    if (!exists(dir))
        dir = dirname(dir);
    return exists(dir) ? readdir(dir)
        .map(name => join(dir, name))
        .filter(d => stat(d).isDirectory())
                       : [];
}

(async () => {
    try {
        if (argv.clean) {
            let folders = await fsp.readdir(tmpdir(), {});
            readline.moveCursor(process.stdout, 0, -1);
            readline.clearLine(process.stdout);
            readline.cursorTo(process.stdout, 0);
            spinner.start('Deleting temporary files...');
            await Promise.all(folders.filter(folder => folder.startsWith(prefix))
                .map(folder => join(tmpdir(), folder))
                .filter(folder => stat(folder).isDirectory())
                .map(rmdir));
            spinner.succeed('Temporary files deleted!');
        } else {
            let cancelled = false;
            let tmp       = (await fsp.readdir(tmpdir(), {})).filter(file => file.startsWith(prefix))[0];
            if (tmp == null)
                tmp = await gitClone(repository, tmpdir());
            else tmp = join(tmpdir(), tmp);
            
            let tags        = ['master', 'dev'].concat((await execa.stdout('git', [
                'tag', '-l', '--sort=-version:refname'
            ], {cwd: tmp})).split('\n'));
            let choice, pageChoices, tag;
            let selected    = 0;
            let offset      = 0, endPos;
            const PAGE_SIZE = 10;
            const PREV      = {title: 'Previous page', value: -2},
                  NEXT      = {title: 'Next page', value: -1};
            while (!choice || choice === PREV.value || choice === NEXT.value) {
                if ((endPos = offset + PAGE_SIZE) >= tags.length)
                    endPos = tags.length - 1;
                pageChoices = tags.map((title, value) => ({title, value}))
                    .slice(offset, endPos);
                
                if (offset > 0)
                    pageChoices = [PREV].concat(pageChoices);
                if (endPos < tags.length - 1)
                    pageChoices.push(NEXT);
                readline.moveCursor(process.stdout, 0, -1);
                readline.clearLine(process.stdout);
                console.log(chalk.bold(`Page ${Math.ceil(endPos / PAGE_SIZE)}/${Math.ceil(tags.length / PAGE_SIZE)}`));
                
                choice = (await prompts({
                    type: 'select',
                    name: 'tag',
                    message: 'Choose a tag/version',
                    choices: pageChoices,
                    initial: selected < pageChoices.length ? selected : pageChoices.length - 1,
                    onState({value, aborted}) {
                        if (cancelled = aborted)
                            console.warn('\n' + 'Cancelled!');
                    }
                }, {
                    onCancel() {
                        cancelled = true;
                        process.exit(0);
                    }
                })).tag;
                
                if (choice === PREV.value)
                    offset -= PAGE_SIZE;
                else if (choice === NEXT.value)
                    offset += PAGE_SIZE;
                
                if (~[PREV.value, NEXT.value].indexOf(choice))
                    readline.moveCursor(process.stdout, 0, -1);
                
                selected = pageChoices.findIndex(c => c.value === choice);
            }
            tag        = (choice = tags[choice]).replace(/\+|_plus_/g, 'b');
            let outDir = join(process.cwd(), prefix + tag);
            
            let outDbSettings;
            if (!cancelled) {
                outDbSettings = await prompts([
                    {
                        type: 'text',
                        name: 'host',
                        message: 'Hostname:',
                        initial: 'localhost'
                    }, {
                        type: 'number',
                        name: 'port',
                        message: 'Port:',
                        initial: 3306,
                        min: 0,
                        max: 65535
                    }, {
                        type: 'text',
                        name: 'dbname',
                        message: `Database name:`,
                        initial: 'test-merge',//`limesurvey-${tag}`, // TODO <<< change
                        format(val) {
                            return val.replace(/[^\w\-.]/g, '_');
                        }
                    }, {
                        type: 'text',
                        name: 'username',
                        message: 'Username:',
                        initial: 'root'
                    }, {
                        type: 'password',
                        name: 'password',
                        message: 'Password:',
                        initial: ''
                    }, {
                        type: 'text',
                        name: 'tablePrefix',
                        message: 'Table prefix:',
                        initial: 'sondage_'
                    }
                ], {onCancel() { cancelled = true; }});
                Object.defineProperties(outDbSettings, {
                    connectionString: {
                        get() {
                            return `mysql:host=${this.host};port=${this.port};dbname=${this.dbname};`;
                        }
                    },
                    prefix: {
                        get() { return this.tablePrefix; }
                    }
                });
            }
            
            let sqlFile = null;
            if (!cancelled) {
                let loop = true;
                while (extname(sqlFile || '').toLowerCase() !== '.sql' && !cancelled && loop) {
                    if (sqlFile) readline.moveCursor(process.stdout, 0, -1);
                    await prompts({
                        type: 'autocomplete',
                        name: 'sqlFile',
                        message: '\x1b[37mSpecify the path to the SQL file to execute\x1b[39m',
                        onRender() {
                            if (this.first) {
                                this.input = sqlFile ? sqlFile.replace(/[\\/]?$/g, sep) : '';
                                setTimeout(() => {
                                    this.cursor = this.input.length;
                                    this.complete(this.render);
                                }, 10);
                            }
                        },
                        suggest() {
                            let val = resolve(this.input || './');
                            // console.log('\n');
                            // console.log(readdir(dir(val)).map(file => ({
                            //     file,
                            //     val,
                            //     junk: junk.is(file),
                            //     dollar: /^(\$|~(?![\\/]|$))/.test(file),
                            //     dots: file.startsWith('.'),
                            //     exists: exists(join(dir(val), file)),
                            //     isDir: stat(join(dir(val), file)).isDirectory(),
                            //     isSQL: extname(file).toLowerCase() === '.sql',
                            //     resDir: resolve(dir(val)) === resolve(val),
                            //     start: file.toLowerCase().startsWith(val.toLowerCase())
                            // })));
                            // console.log('\n');
                            return Promise.resolve(
                                readdir(dir(val))
                                    .map(file => join(dir(val), file))
                                    .filter(file =>
                                        exists(file)
                                        && (stat(file).isDirectory()
                                            || extname(file).toLowerCase() === '.sql')
                                        && (argv.includeJunk ||
                                            (junk.not(basename(file))
                                             && !/^(\$|~(?![\\/]|$))/.test(basename(file))))
                                        && (argv.includeDots || !basename(file).startsWith('.'))
                                        && (resolve(dir(val)) === resolve(val)
                                            || file.toLowerCase().startsWith(val.toLowerCase())))
                                    .map(value => ({title: basename(value), value})));
                        }
                    }, {
                        onCancel() {
                            sqlFile = null;
                            loop    = false;
                        },
                        onSubmit(p, v) {
                            sqlFile = v;
                        }
                    });
                }
            }
            
            
            let merged = [];
            if (!cancelled) {
                let loop         = true;
                const onKeypress = (rel = '') => function onKeypress(str, key) {
                    const getTo = p => join(rel, p);
                    if (key.name === 'return') {
                        if (exists(getTo(this.input))
                            && stat(getTo(this.input)).isDirectory())
                            this.input = join(this.input, this.suggestions[this.select].value);
                        else this.input = join(dir(this.input),
                            (this.suggestions[this.select] || {}).value || '');
                        if (stat(getTo(this.input)).isDirectory()) this.input += sep;
                        this.cursor = this.input.length;
                        this.complete(this.render);
                        this.render();
                    } else if (key.name === 'enter') {
                        this.done        = true;
                        this.value       = this.input;
                        this.suggestions = [];
                        this.select      = undefined;
                        this.render();
                        this.out.write('\n');
                        this.close();
                    }
                    return !['return', 'enter'].includes(key.name);
                };
                const suggest    = (rel = '') => function suggest() {
                    const getTo = p => join(rel, p);
                    let val     = this.input || '';
                    return Promise.resolve(
                        readdir(dir(getTo(val)))
                            .filter(file => {
                                let fullPath = join(dir(getTo(val)), file);
                                return exists(fullPath)
                                       && stat(fullPath).isDirectory()
                                       && (argv.includeJunk ||
                                           (junk.not(file)
                                            && !/^(\$|~(?![\\/]|$))/.test(file)))
                                       && (argv.includeDots || !file.startsWith('.'))
                                       && (resolve(dir(val)) === resolve(val)
                                           || fullPath.toLowerCase()
                                               .startsWith(getTo(val)
                                                   .toLowerCase()));
                            })
                            .map(value => ({title: basename(value), value})));
                };
                while (loop) {
                    let obj = await prompts([
                        {
                            type: 'toggle',
                            name: 'added',
                            message: 'Add files or folders into the new limesurvey directory?',
                            initial: false,
                            active: 'Yes',
                            inactive: 'No',
                            onState({value, aborted}) {
                                loop      = value && !aborted;
                                cancelled = aborted;
                            }
                        }, {
                            type: prev => prev && 'autocomplete',
                            name: 'dirFrom',
                            message: 'Specify the parent directory containing the files you want to copy',
                            onKeypress: onKeypress,
                            suggest: suggest() // FIXME <<<<<<
                        }, {
                            type: prev => prev && 'text',
                            name: 'globFrom',
                            message: 'Specify the glob to filter the files/folder to copy',
                            initial: '**/*'
                        }, {
                            type: prev => prev && 'autocomplete',
                            name: 'to',
                            message: 'Specify the path where you want to place your new files',
                            onKeypress: onKeypress(tmp),
                            suggest: suggest(tmp)
                        }
                    ]);
                    
                    if (!cancelled && obj.to) merged.push(obj);
                    
                    // console.log();
                    // if (globFrom && loop) {
                    //     const getTo   = p => resolve(tmp, p);
                    //     // while ((!exists(getTo()) || stat(getTo()).isDirectory()) && !cancelled && innerLoop) {
                    //     readline.moveCursor(process.stdout, 0, -1);
                    //     await prompts({
                    //         type: 'autocomplete',
                    //         name: 'to',
                    //         message: 'Specify the path where you want to place your new files',
                    //         // onRender() {
                    //         //     if (this.first) {
                    //         //         this.input = to ? to.replace(/[\\/]?$/, sep) : '';
                    //         //         setTimeout(() => {
                    //         //             this.cursor = this.input.length;
                    //         //             this.complete(this.render);
                    //         //         }, 10);
                    //         //     }
                    //         // },
                    //         onKeypress(str, key) {
                    //             if (key.name === 'return') {
                    //                 if (exists(getTo(this.input))
                    //                     && stat(getTo(this.input)).isDirectory())
                    //                     this.input = join(this.input, this.suggestions[this.select].value);
                    //                 else this.input = join(dir(this.input),
                    //                     (this.suggestions[this.select] || {}).value || '');
                    //                 if (stat(getTo(this.input)).isDirectory()) this.input += sep;
                    //                 this.cursor = this.input.length;
                    //                 this.complete(this.render);
                    //                 this.render();
                    //             } else if (key.name === 'enter') {
                    //                 this.done = true;
                    //                 this.value = this.input;
                    //                 this.suggestions = [];
                    //                 this.select = undefined;
                    //                 this.render();
                    //                 this.out.write('\n');
                    //                 this.close();
                    //             }
                    //             return !['return', 'enter'].includes(key.name);
                    //         },
                    //         suggest() {
                    //             let val = this.input || '';
                    //             return Promise.resolve(
                    //                 readdir(dir(getTo(val)))
                    //                     .filter(file => {
                    //                         let fullPath = join(dir(getTo(val)), file);
                    //                         return exists(fullPath)
                    //                                && stat(fullPath).isDirectory()
                    //                                && (argv.includeJunk ||
                    //                                    (junk.not(file)
                    //                                     && !/^(\$|~(?![\\/]|$))/.test(file)))
                    //                                && (argv.includeDots || !file.startsWith('.'))
                    //                                && (resolve(dir(val)) === resolve(val)
                    //                                    || fullPath.toLowerCase()
                    //                                        .startsWith(getTo(val)
                    //                                            .toLowerCase()));
                    //                     })
                    //                     .map(value => ({title: basename(value), value})));
                    //         }
                    //     }, {
                    //         onCancel() {
                    //             cancelled = cancelled || merged.length === 0;
                    //         }, onSubmit(p, to) {
                    //             merged.push({globFrom, to});
                    //         }
                    //     });
                    //     console.log();
                    // }
                    // }
                }
            }
            if (!cancelled) {
                console.log('\n\n\n\n\n\n');
                await prompts({
                    type: 'toggle',
                    name: 'cancel',
                    message: `Please confirm you want to checkout limesurvey@${choice}\n  `
                             + `and apply the following database settings:\n  `
                             + `   hostname => ${outDbSettings.host},\n  `
                             + `       port => ${outDbSettings.port},\n  `
                             + `   database => ${outDbSettings.dbname},\n  `
                             + `   username => ${outDbSettings.username},\n  `
                             + `     prefix => ${outDbSettings.prefix}\n  `
                             + `and copy the following files/folders:\n  `
                             + merged.map(({globFrom, to}) => `     ${globFrom} => ${to}\n`),
                    initial: false,
                    active: 'Cancel',
                    inactive: 'Confirm',
                    onState({value, aborted}) {
                        cancelled = aborted || value;
                    }
                }, {onCancel() { cancelled = true; }});
            }
            
            if (!cancelled) {
                console.log();
                console.log(chalk.bold.cyan('------------- PROCESSING -------------'));
                spinner.start(`Checking out limesurvey@${choice}`);
                await execa('git', [
                    'checkout', ['dev', 'master'].includes(choice) ? choice : `tags/${choice}`
                ], {cwd: tmp});
                spinner.succeed(`limesurvey@${choice} checked out!`);
                if (exists(outDir)) { // TODO Prompts user > delete existing directory
                    console.log(chalk.yellow('Output directory already exists.') + chalk.keyword('orange')('\n\tDeleting it before copying temporary files...'));
                    spinner.start('Deleting directory ' + outDir);
                    await rmdir(outDir);
                    spinner.succeed('Directory deleted!');
                }
                spinner.start(`Copying temporary files to ${outDir}`);
                await copy(tmp, outDir, {overwrite: true, dereference: true});
                spinner.succeed('Temporary files copied!');
                
                spinner.start(`Copying selected files/folders to ${outDir}`);
                await Promise.all(merged.map(async ({dirFrom, globFrom, to}) =>
                    await Promise.all((await glob(globFrom, {cwd: dirFrom}))
                        .map(file => ({fullPath: resolve(dirFrom), file}))
                        .map(({file, fullPath}) => copy(fullPath, join(outDir, to, dirname(file)))))));
                spinner.succeed(`Selected files/folders copied!`);
                
                spinner.start(`Updating config.php file`);
                let configFilePath = join(outDir, 'application/config/config.php');
                let dfltCfgFile    = join(outDir, 'application/config/config-sample-mysql.php');
                if (!exists(configFilePath) && exists())
                    await fsp.copyFile(dfltCfgFile, configFilePath);
                if (exists(configFilePath)) {
                    await fsp.writeFile(configFilePath,
                        (await fsp.readFile(configFilePath, {encoding: 'utf8'}))
                            .replace(/(?<='db'\s*=>\s*array\()[^)]+(?=\))/, match =>
                                match.replace(/(?<=[^\w]+(\w+)[^\w\n]+?)(?:\w[^',\n]+|(')')/g,
                                    (m, opt, a) => `${a || ''}${outDbSettings[opt]}${a || ''}`)));
                    spinner.succeed('Config file updated!');
                } else {
                    spinner.fail('Config file not found!');
                    await prompts({
                        type: 'toggle',
                        name: 'createDb',
                        message: `The configuration file could not be found.\n  `
                                 + `Do you want to create the database anyway?`,
                        initial: false,
                        active: 'No',
                        inactive: 'Yes',
                        onState({value, aborted}) {
                            cancelled = value || aborted;
                        }
                    }, {onCancel() {cancelled = true;}});
                }
                
                if (!cancelled) {
                    let dbName = prefix + tag;
                    spinner.start(`Establishing connections with databases`);
                    const outConnection = createConnection({
                        host: outDbSettings.host,
                        port: outDbSettings.port,
                        user: outDbSettings.username,
                        password: outDbSettings.password
                    });
                    // const srcConnection = createConnection({
                    //     host: srcDbSetting.host,
                    //     port: srcDbSetting.port,
                    //     user: srcDbSetting.username,
                    //     password: srcDbSetting.password
                    // });
                    spinner.succeed(`Connections established!`);
                    
                    function query(out, query, args) {
                        const conn = out ? outConnection : srcConnection;
                        return new Promise((res, reject) => {
                            let result = {
                                rows: [],
                                fields: []
                            };
                            conn.query(query, args)
                                .on('error', reject)
                                .on('result', row => result.rows.push(row))
                                .on('fields', f => result.fields.push(f))
                                .on('end', res);
                        });
                    }
                    
                    spinner.start(`Creating database ${dbName}`);
                    let result = await query(true, `SELECT schema_name
                                                    FROM information_schema.schemata
                                                    WHERE scheme_name = ?`, [dbName]);
                    console.log(result);
                    if (result.rows.length > 0) {
                        spinner.warn(`Could not create database:\n\tDatabase ${dbName} already exists.`);
                    } else {
                        await query(true, 'CREATE DATABASE ?', [dbName]);
                        spinner.succeed(`Database created!`);
                        
                        if (sqlFile && exists(sqlFile)) {
                            spinner.start(`Executing SQL file (${sqlFile})`);
                            await query(true, fsp.readFile(sqlFile, 'utf8'));
                            spinner.succeed(`SQL file executed!`);
                        }
                    }
                }
                
                // if (!cancelled) {
                //     let dbName = settings.prefix + tag;
                //     spinner.start(`Creating database ${dbName}`);
                //     let sql = `"${settings.sql.executable}" -u ${settings.sql.user}`;
                //     if (typeof settings.sql.password === 'string')
                //         sql += ` -p ${settings.sql.password}`;
                //     let cmd = `echo SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '${dbName}';`;
                //     const TEMP_CMD_FILE = join(tmpdir(), settings.prefix + process.hrtime.bigint().toString(36) + '.cmd');
                //     try {
                //         await fsp.writeFile(TEMP_CMD_FILE, cmd);
                //
                //         console.log('\n%o', await execa(`${sql} < ${TEMP_CMD_FILE}`));
                //         if (!(await execa(`${sql} < ${TEMP_CMD_FILE}`)).stdout) {
                //             cmd = cmd.replace(/^[^|]+/, `echo CREATE DATABASE ${dbName}`);
                //             await execa(cmd);
                //             spinner.succeed('Database created!');
                //         } else {
                //             spinner.warn(`Could not create database:\n\tDatabase ${dbName} already exists.`);
                //         }
                //     } catch(err) {
                //         if (argv.verbose)
                //             console.log('\n' + chalk.yellow(err.stack));
                //         spinner.fail('Database creation failed!');
                //         process.exit(1);
                //     }
                // } else
                //     console.log(chalk.keyword('orange')('Database won\'t be created!'));
            } else
                console.warn('\n' + chalk.keyword('orange')('Cancelled!'));
            
            if (!cancelled) console.log(chalk.hex('#00FF00').bold('Done!'));
        }
    } catch (err) {
        if (argv.verbose)
            console.log('\n' + chalk.yellow(err.stack));
        spinner.fail(`${err.constructor.name}: ${err.message}`);
        process.exit(1);
    }
    process.exit(0);
})();

