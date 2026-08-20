export interface IntellisenseColumn {
    name: string;
    data_type?: string | null;
    description?: string | null;
}

export interface ColumnIntellisenseMetadata {
    models: Array<{ name: string; columns: IntellisenseColumn[] }>;
    sources: Array<{ source_name: string; table_name: string; columns: IntellisenseColumn[] }>;
}

const SQL_ALIAS_STOP_WORDS = new Set([
    'cross', 'full', 'group', 'having', 'inner', 'join', 'left', 'limit',
    'on', 'order', 'outer', 'right', 'union', 'where',
]);

export function getColumnQualifier(textBeforeCursor: string): string | null {
    return textBeforeCursor.match(/([A-Za-z_][\w$]*)\.[\w$]*$/)?.[1] || null;
}

export function resolveColumnsForQualifier(
    sql: string,
    qualifier: string,
    metadata: ColumnIntellisenseMetadata,
): IntellisenseColumn[] {
    const relations = new Map<string, IntellisenseColumn[]>();
    const models = new Map(metadata.models.map((item) => [item.name.toLowerCase(), item.columns]));
    const sources = new Map(
        metadata.sources.map((item) => [`${item.source_name}.${item.table_name}`.toLowerCase(), item.columns]),
    );

    const addRelation = (name: string | undefined, columns: IntellisenseColumn[] | undefined) => {
        if (!name || !columns || SQL_ALIAS_STOP_WORDS.has(name.toLowerCase())) return;
        relations.set(name.toLowerCase(), columns);
    };

    const refRelation = /(?:from|join)\s+\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
    for (const match of sql.matchAll(refRelation)) {
        const columns = models.get(match[1].toLowerCase());
        addRelation(match[1], columns);
        addRelation(match[2], columns);
    }

    const sourceRelation = /(?:from|join)\s+\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
    for (const match of sql.matchAll(sourceRelation)) {
        const columns = sources.get(`${match[1]}.${match[2]}`.toLowerCase());
        addRelation(match[2], columns);
        addRelation(match[3], columns);
    }

    const refCte = /(?:with|,)\s*([A-Za-z_][\w$]*)\s+as\s*\([\s\S]*?\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi;
    for (const match of sql.matchAll(refCte)) {
        addRelation(match[1], models.get(match[2].toLowerCase()));
    }

    const sourceCte = /(?:with|,)\s*([A-Za-z_][\w$]*)\s+as\s*\([\s\S]*?\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi;
    for (const match of sql.matchAll(sourceCte)) {
        addRelation(match[1], sources.get(`${match[2]}.${match[3]}`.toLowerCase()));
    }

    return relations.get(qualifier.toLowerCase()) || [];
}
