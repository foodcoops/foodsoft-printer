const WebSocket = require('ws');
const printer = require('printer');
const request = require('request');

const address = 'http://127.0.0.1:3000/aaa/';
const token = 'abcdefg';
const printerNam = '';

const jobs = new Map();
let connectionState = 'Disconnected';
let ws;
let timer;
const timeout = 1000;

class Job {
  constructor(id) {
    this.id = id;
    this.stopped = false;
  }

  log(text) {
    console.log(`#${this.id}: ${text}`);
  }

  setState(state, message) {
    let timeout = 0;
    if (this.state === state) {
       if (this.message === message) return;
       timeout = 5000;
    } else {
      clearTimeout(this.stateTimeout);
      this.stateTimeout = null;
    }

    this.state = state;
    this.message = message;
    this.pending = true;
    this.log(`${state}: ${message}`);

    if (this.stateTimeout) return;
    this.stateTimeout = setTimeout(this.sendState.bind(this), timeout);
  }

  sendState() {
    this.stateTimeout = null;
    triggerWebsocket();
  }

  hasPendingUpdate() {
    return this.finish || this.pending;
  }

  pendingUpdate() {
    const obj = { id: this.id };
    if (this.finish) obj.finish = true;
    if (this.pending) {
      obj.state = this.state;
      obj.message = this.message;
      this.pending = false;
    }
    return obj;
  }

  start() {
    this.log(`Started`);
    this.download();
  }

  stop() {
    if (this.finish) {
      jobs.delete(this.id);
      this.log(`Finished`);
      return
    }
    if (this.stoppend) return;
    if (this.jobId) printer.setJob(printerNam, this.jobId, 'CANCEL');
    this.log(`Stopped`);
    this.stoppend = true;
  }

  download() {
    request
      .get(`${address}/printer/${this.id}`)
      .auth(null, null, true, token)
      .on('error', (err) => {
        this.setState('downloading', `Error: ${err.message}`);
      })
      .on('response', (res) => {
        if (res.statusCode !== 200) {
          this.setState('downloading', `Bad HTTP status: ${res.statusCode}`);
          return setTimeout(this.download.bind(this), timeout);
        }
        this.chunks = [];
        this.receivedLength = 0;
        this.setState('downloading', 'Received response headers');
      })
      .on('data', (data) => {
        this.chunks.push(data);
        this.receivedLength += data.length;
        this.setState('downloading', `Downloaded ${this.receivedLength} bytes`);
      })
      .on('end', () => {
        this.data = Buffer.concat(this.chunks);
        this.chunks = null;
        this.setState('downloading', 'Completed');
        this.print();
      })
    this.setState('downloading');
  }

  print() {
    printer.printDirect({
      data: this.data,
      type: 'PDF',
      success: this.printSuccess.bind(this),
      error: this.printError.bind(this)
    });
  }

  printSuccess(jobId) {
    this.jobId = jobId;
    this.checkJob();
  }

  printError(err) {
    this.setState('pending', `Error: ${err.message}`);
    setTimeout(this.print.bind(this), timeout);
  }

  checkJob() {
    const job = printer.getJob(printerNam, this.jobId);

    const statusMap = new Map(Object.entries({
      ABORTED: 'aborted',
      CANCELLED: 'cancelled',
      PAUSED: 'stopped',
      PENDING: 'pending',
      PRINTED: 'completed',
      PRINTING: 'processing',
    }));

    statusMap.forEach((state, status) => {
      if (job.status.indexOf(status) === -1) return;
      this.setState(state, `Job #${this.jobId}`);
    })

    if (job.completedTime.getTime()) return this.complete();
    setTimeout(this.checkJob.bind(this), timeout);
  }

  complete() {
    this.finish = true;
    this.sendState();
  }
}

function triggerWebsocket() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  let idle = true;
  jobs.forEach(job => {
    if (!job.hasPendingUpdate()) return;
    const text = JSON.stringify(job.pendingUpdate());
    ws.send(text);
    console.log(`SEND ${text}`);
  });
  if (idle) ws.send('{}');

  clearTimeout(timer);
  timer = setTimeout(triggerWebsocket, timeout);
}

function setPendingJobs(ids) {
  ids.forEach(id => {
    if (jobs.has(id)) return;
    const job = new Job(id);
    jobs.set(id, job)
    job.start();
  });

  jobs.forEach((job, id) => {
    if (ids.indexOf(id) !== -1) return;
    job.stop();
  })
}

function setConnectionState(text) {
  if (connectionState === text) return;
  connectionState = text;
  console.log(text);
}

function connect() {
  const options = {
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
  let error;

  ws = new WebSocket(address + '/printer/socket', null, options);

  ws.on('open', () => {
    error = 'OK';
    setConnectionState(`Connected to ${address}`);
    triggerWebsocket();
  });

  ws.on('error', (e) => {
    error = e;
  });

  ws.on('close', (status) => {
    setConnectionState(`Disconnected (${status}): ${error}`);
    setTimeout(connect, timeout);
    ws = null;
  });

  ws.on('message', (data) => {
    try {
      setPendingJobs(JSON.parse(data));
    } catch (err) {
      console.error(err.message);
    }
  });
}

connect();
