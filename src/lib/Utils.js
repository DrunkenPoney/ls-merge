const AsyncFunction = (async () => {}).constructor;

module.exports.AsyncFunction = AsyncFunction;
module.exports.isAsyncFunction = func => {
    return func != null
        && (func[Symbol.toStringTag] === 'AsyncFunction'
            || func instanceof AsyncFunction);
};