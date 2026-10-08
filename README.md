# viewdiagramSQL

Visor de diagramas entidad-relación para **PostgreSQL**. Pega tu SQL o importa un archivo `.sql` y obtienes el diagrama al instante, con tablas, relaciones, enums, tipos compuestos, dominios y vistas.

Usa el **parser real de PostgreSQL 17** ([libpg_query](https://github.com/pganalyze/libpg_query) compilado a WebAssembly), así que entiende la misma sintaxis que tu servidor. Todo corre en el navegador: tu SQL no se envía a ningún servidor.

## Qué entiende

| Objeto | Cómo se muestra |
| --- | --- |
| `CREATE TABLE` (columnas, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`, `CHECK`, `GENERATED`, `IDENTITY`, `COLLATE`) | Nodo de tabla con iconos de PK / FK / UNIQUE y `?` para columnas nulables |
| `FOREIGN KEY` en columna, en tabla o vía `ALTER TABLE ... ADD CONSTRAINT`, incluidas las compuestas | Relación con notación pata de gallo (1:1, 1:N, opcional) y `ON DELETE` / `ON UPDATE` |
| `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE / RENAME VALUE` | Nodo enum con sus valores en orden |
| `CREATE TYPE ... AS (...)` (compuestos), `AS RANGE`, tipos base | Nodo de tipo; las columnas que lo usan se enlazan con línea punteada |
| `CREATE DOMAIN` con `CHECK`, `NOT NULL` y `DEFAULT` | Nodo de dominio |
| `CREATE VIEW`, `CREATE MATERIALIZED VIEW` | Nodo de vista con sus columnas y las tablas de las que depende |
| `INHERITS`, `PARTITION BY`, `PARTITION OF`, `ATTACH PARTITION`, `LIKE`, `OF tipo` | Columnas heredadas y relación de herencia/partición |
| `CREATE INDEX` (único, parcial, por expresión, `USING gin/gist/...`, `INCLUDE`) | Sección de índices en la tabla |
| `COMMENT ON`, `CREATE TRIGGER`, `CREATE POLICY`, `ENABLE ROW LEVEL SECURITY` | Detalle en el inspector y distintivos en la tabla |
| Esquemas, `SET search_path`, `RENAME`, `DROP`, `ALTER COLUMN ...` | Se aplican en orden, como lo haría Postgres |
| Dumps de `pg_dump` (`COPY ... FROM stdin`, `\connect`, `set_config`) | Se ignoran los datos y meta-comandos |

Si hay errores de sintaxis, se marca la línea y columna exactas en el editor y se sigue dibujando todo lo que sí es válido.

## Uso

- **Importar .sql** o arrastrar el archivo sobre la ventana.
- Editar el SQL en el panel izquierdo: el diagrama se actualiza mientras escribes.
- Arrastrar tablas para acomodarlas. Las posiciones se guardan en el navegador.
- **Reordenar** aplica un layout automático (ELK).
- Clic en una tabla para ver su detalle completo y resaltar sus relaciones.
- **Exportar** a PNG, SVG o al archivo `.sql`.
- Filtrar por esquema y mostrar u ocultar tipos y vistas desde la pestaña *Objetos*.

## Desarrollo

```bash
npm install
npm run dev      # servidor local
npm test         # tests del parser
npm run build    # build de producción en dist/
```

Stack: React 19, Vite, [React Flow](https://reactflow.dev), [ELK](https://eclipse.dev/elk/) para el layout, CodeMirror 6, `libpg-query` + `pgsql-deparser`.

### Estructura

```
src/
  schema/      SQL → modelo (parser WASM, deparser, división de sentencias)
  diagram/     modelo → nodos/aristas, layout ELK, componentes de React Flow
  panels/      editor SQL, lista de objetos, inspector
```

## Despliegue

Cada push a `main` compila y publica en GitHub Pages mediante `.github/workflows/deploy.yml`. En *Settings → Pages* la fuente debe ser **GitHub Actions**.
