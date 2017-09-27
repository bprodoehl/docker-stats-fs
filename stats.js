#!/usr/bin/env node

'use strict';

var async = require('async');
var fs = require('fs');
var through = require('through2');
//var split = require('split2');
//var pump = require('pump');
var allContainers = require('docker-allcontainers');

// This function is from https://github.com/soldair/node-procfs-stats
function sectiontable(buf) {
  if (!buf) { return false; }
  var lines = buf.toString().trim().split('\n');
  var sections = lines.shift();

  var columns = lines.shift().trim().split('|');
  sections = sections.split('|');

  var s,l,c,p = 0,map = {},keys = [];
  for (var i=0; i<sections.length; ++i) {
    s = sections[i].trim();
    l = sections[i].length;
    c = columns[i].trim().split(/\s+/g);
    while(c.length) {
      map[keys.length] = s;
      keys.push(c.shift());
    }
    p += s.length+1;
  }

  var data = [];
  lines.forEach(function(l) {
    l = l.trim().split(/\s+/g);
    var o = {};
    for (var i=0; i<l.length; ++i) {
      var s = map[i];
      // Inter-|
      // face  |
      /*
        {
          "Interface":"eth0"
        }
      */
      if (s.indexOf('-') === s.length-1) {
        o[s.substr(s,s.length-1)+keys[i]] = l[i].replace(/:$/, '');
      } else {
        /*
        {
          bytes:{
            Receive:43124236,
            Transmit:87782782
          }
        }
        */
        if (!o[keys[i]]) {
          o[keys[i]] = {};
        }
        o[keys[i]][s] = l[i];
      }
    }
    data.push(o);
  });

  return data;
}

function stats(opts, callback) {
  opts = opts || {};
  var result = through.obj();
  var events = opts.events || allContainers(opts);
  var containers = {};
  var oldDestroy = result.destroy;
  var interval = opts.statsinterval || 1;
  var statsPullInProgress = false;
  var procPath = opts.procPath || '/proc/';

  var netStats = opts.net || false;

  function detachContainer(id) {
    if (containers[id]) {
      delete containers[id];
    }
  }

  function attachContainer(data, container) {
    // we are trying to tap into this container
    // we should not do that, or we might be stuck in
    // an output loop
    if (data.id.indexOf(process.env.HOSTNAME) === 0) {
      return;
    }
    // we need the pid for network stats
    container.inspect(function (err, details) {
      if (!err) {
        //console.log(details);
        data.info = details;
        containers[data.id] = {meta: data, docker: container};
      }
    });
  }

  // this function takes the /proc/net/dev format and converts it to match
  function transformProcToDocker(data, stats) {
    for (var idx in data) {
      var iface = data[idx];
      //console.log('Looking at ' + JSON.stringify(iface));
      if (!stats.networks) { stats.networks = {}; }
      stats.networks[iface.Interface] = {
        'rx_bytes': parseInt(iface.bytes.Receive, 10),
        'rx_dropped': parseInt(iface.drop.Receive, 10),
        'rx_errors': parseInt(iface.errs.Receive, 10),
        'rx_packets': parseInt(iface.packets.Receive, 10),
        'tx_bytes': parseInt(iface.bytes.Transmit, 10),
        'tx_dropped': parseInt(iface.drop.Transmit, 10),
        'tx_errors': parseInt(iface.errs.Transmit, 10),
        'tx_packets': parseInt(iface.packets.Transmit, 10)
      };
    }
  }

  function getContainerStats(container, next) {
    var containerObj = containers[container];
    if (containerObj && containerObj.docker) {
      var containerPid = 0;
      if (containerObj.meta.info && containerObj.meta.info.State) {
        containerPid = containerObj.meta.info.State.Pid;
      }
      //console.log('Pulling stats on ' + JSON.stringify(containerObj.meta));//containerObj.Pid);
      // console.log('Pulling stats on ' + containerObj.meta.id +
      //             ' (pid ' + containerPid + ')');
      if (netStats && containerPid) {
        //console.log('Looking for network stats');
        fs.readFile(procPath + containerPid + '/net/dev', function(err, buf) {
          if (err) {
            console.log('Error fetching network stats: ' + JSON.stringify(err));
            callback(err);
          } else {
            var data = sectiontable(buf);
            //console.log(JSON.stringify(data));
            var stats = {};
            transformProcToDocker(data, stats);
            result.push({
              v: 0,
              id: container.slice(0, 12),
              image: containerObj.meta.image,
              name: containerObj.meta.name,
              stats: stats
            });
          }
          next();
        });
      } else {
        console.log('no pid for that one!');
        next();
      }
    } else {
      next();
    }
  }

  function getAllContainerStats() {
    if (statsPullInProgress) {
      console.log('Skipping, because pull is already in progress!');
      return;
    }
    statsPullInProgress = true;
    async.eachSeries(Object.keys(containers),
                     async.ensureAsync(getContainerStats), function() {
      statsPullInProgress = false;
    });
  }

  result.setMaxListeners(0);

  result.destroy = function() {
    console.log('Destroying result stream.');
    Object.keys(containers).forEach(detachContainer);
    events.destroy();
    oldDestroy.call(this);
  };

  events.on('start', attachContainer);
  events.on('stop', function(meta) {
    detachContainer(meta.id);
  });

  setInterval(getAllContainerStats, interval*1000);

  return result;
}

module.exports = stats;

function cli() {
  var argv = require('minimist')(process.argv.slice(2));
  stats({
    statsinterval: argv.statsinterval,
    matchByName: argv.matchByName,
    matchByImage: argv.matchByImage,
    skipByName: argv.skipByName,
    skipByImage: argv.skipByImage,
    procPath: argv.procPath,
    cpuStats: argv.cpu,
    ioStats: argv.io,
    netStats: argv.net
  }).pipe(through.obj(function(chunk, enc, cb) {
    this.push(JSON.stringify(chunk));
    this.push('\n');
    cb();
  })).pipe(process.stdout);
}

if (require.main === module) {
  cli();
}
