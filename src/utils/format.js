export function snakeToCamel(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(snakeToCamel);
    }
    return Object.keys(obj).reduce((acc, key) => {
        const camelKey = key.replace(/([-_][a-z])/g, group =>
            group.toUpperCase().replace('-', '').replace('_', '')
        );
        // Special case mapping if necessary
        if (key === 'preserve_recent') {
            acc['preserveLastN'] = obj[key];
        } else {
            acc[camelKey] = snakeToCamel(obj[key]);
        }
        return acc;
    }, {});
}

export function camelToSnake(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(camelToSnake);
    }
    return Object.keys(obj).reduce((acc, key) => {
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        if (key === 'preserveLastN') {
            acc['preserve_recent'] = obj[key];
        } else {
            acc[snakeKey] = camelToSnake(obj[key]);
        }
        return acc;
    }, {});
}
