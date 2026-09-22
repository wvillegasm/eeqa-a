## Plan de Especificacion para IA Generadora: Estructura del MVP Hexagonal

Este documento sirve como _prompt_ arquitectónico estructurado para que una IA genere el código base del MVP. El objetivo de este código es simular el procesamiento I/O-bound y el manejo de flujos de datos pesados sin bloquear el Event Loop.

### 1. Capa de Dominio (`src/domain/`)

- **`entities/Study.js`**:
- Clase que representará el estudio extraído de DB2.
- Debe incluir propiedades: `id`, `ssn`, `status` (valores: `PENDING`, `PROCESSING`, `COMPLETED`, `ERROR`), `payloadSize`.
- Debe contener métodos puros para transiciones de estado (`markAsProcessing()`, `markAsCompleted()`, `markAsError()`).

### 2. Capa de Casos de Uso (`src/application/`)

- **`use-cases/ProcessStudyUseCase.js`**:
- Inyectar tres puertos mediante el constructor: `studyRepository`, `infoServiceClient`, `storageService`.
- **Flujo de ejecución asíncrono (`async execute(studyId)`):**

1. Llama a `studyRepository.getStudyById(studyId)`.
2. Llama a `infoServiceClient.fetchT2T18Data(study.ssn)`.
3. Inicia un _stream_ hacia S3 llamando a `storageService.uploadStream(studyId, dataStream)`.
4. Actualiza el estado a `COMPLETED` vía `studyRepository.updateStudyStatus(study)`.

- Debe incluir bloques `try/catch` rigurosos que, en caso de fallo, actualicen el estado a `ERROR`.

### 3. Capa de Puertos/Interfaces (`src/ports/`)

- Definir los contratos (clases base con métodos que lanzan `NotImplementedError` o interfaces en JSDoc/TypeScript si se decide tipar):
- **`IStudyRepository`**: `getStudyById(id)`, `updateStudyStatus(study)`.
- **`IInfoServiceClient`**: `fetchT2T18Data(ssn)`.
- **`IStorageService`**: `uploadStream(filename, readableStream)`.

### 4. Capa de Infraestructura / Adaptadores (`src/infrastructure/`)

- **`web/ExpressController.js`**:
- Maneja la ruta `POST /api/v1/studies/:id/process`.
- Recibe la petición, invoca `ProcessStudyUseCase` y devuelve un HTTP 202 (Accepted) inmediatamente para delegar el proceso en background (o HTTP 200 si se espera la resolución para la prueba).

- **`adapters/MockDB2Repository.js`**:
- Implementa `IStudyRepository`.
- Usa `setTimeout` envuelto en Promesas para simular una latencia de red de 1.5 segundos por consulta.
- **Simulación de Pool:** Implementar un semáforo básico que limite las llamadas concurrentes a un máximo de 30 (simulando las restricciones de DB2).

- **`adapters/MockT2T18Client.js`**:
- Implementa `IInfoServiceClient`.
- Simula una latencia asíncrona alta (3 a 5 segundos) devolviendo un generador de _Streams_ legibles (`stream.Readable`) que emita fragmentos de datos (_chunks_) generados al vuelo.

- **`adapters/S3StreamStorage.js`**:
- Implementa `IStorageService`.
- En lugar de subir a AWS real, utiliza `stream.PassThrough` conectado a `/dev/null` (o escribiendo a un archivo local temporal) para consumir el flujo de datos de 100MB simulando el ancho de banda, garantizando que los datos no se acumulen en la RAM (`chunking`).

### 5. Inyección de Dependencias (`src/main.js`)

- Punto de entrada (`Composition Root`).
- Instancia los adaptadores simulados, los inyecta en `ProcessStudyUseCase`, inicializa Express y arranca el servidor en el puerto 3000.

---

## Plan de Ejecución: Estrategia de Simulación y Medición

Este plan define cómo someteremos el MVP hexagonal a estrés para extraer métricas empíricas que desmientan los temores de bloqueo y saturación de memoria.

### 1. Herramientas y Entorno

- **Entorno:** Despliegue del MVP en un contenedor Docker con límites estrictos de recursos (ej. 1 CPU core, 512MB RAM) para simular un Pod en OpenShift (PaaS).
- **Generador de Carga:** `Autocannon` (basado en Node.js, excelente para HTTP pipelining) o `k6`.
- **Telemetría:** `Clinic.js Doctor` para perfilar el Event Loop, y un middleware personalizado en Express usando `process.memoryUsage()` y `perf_hooks`.

### 2. Diseño de los Escenarios de Prueba

**Escenario A: Prueba de Concurrencia Extrema (I/O-Bound)**

- **Objetivo:** Demostrar que el hilo principal no se bloquea por llamadas pesadas a DB2 o T2/T18.
- **Ejecución:** Enviar 2,000 peticiones concurrentes al endpoint durante 30 segundos. Cada petición internamente tardará ~5 segundos (por los delays inyectados en los mocks).
- **Métrica de Éxito:** El servidor no debe rechazar conexiones (`0` errores `ECONNREFUSED` o `ETIMEOUT`). El tiempo de respuesta de una petición simple paralela (ej. `GET /health`) debe mantenerse por debajo de los 50ms durante todo el bombardeo.

**Escenario B: Prueba de Streaming de Archivos Masivos (C3)**

- **Objetivo:** Demostrar que la transferencia de archivos gigantes (100MB+) hacia S3 no consume la RAM del contenedor.
- **Ejecución:** Modificar `MockT2T18Client` para que genere un flujo (`Readable Stream`) de 200MB de datos en memoria dinámica. Lanzar 50 peticiones concurrentes de este flujo.
- **Métrica de Éxito:** Si cargáramos en RAM, 50 * 200MB consumirían 10GB de memoria, crasheando el contenedor de 512MB inmediatamente (`OOMKilled`). Al usar *Streams\*, debemos observar en los logs que la métrica `heapUsed` de Node.js nunca supera los 80-100MB en total a lo largo de toda la prueba.

### 3. Captura y Reporte de Telemetría

- **Middleware de Monitoreo (A inyectar en el MVP):**

```javascript
setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`Heap Used: ${Math.round(memory.heapUsed / 1024 / 1024)} MB`);
}, 1000);
```

- **Reporte de Clinic.js:** Envolver la ejecución del servidor con `clinic doctor -- node src/main.js`. Esto generará un gráfico HTML interactivo al finalizar la prueba de Autocannon.
- **Entregable Final para el Equipo:** Un reporte que muestre el gráfico de Event Loop Lag (que debe permanecer cercano a 0) cruzado con el gráfico de uso de CPU y RAM, demostrando visualmente que Node.js pasó la mayor parte del tiempo durmiendo (esperando I/O) mientras procesaba miles de transacciones de forma segura.
