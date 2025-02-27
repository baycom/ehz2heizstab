const util=require('util');
const mqtt=require('mqtt');
const request = require('request');
const EWMA = require('ewma');
const interpolateArrays = require('interpolate-arrays')
const commandLineArgs = require('command-line-args')

const optionDefinitions = [
	{ name: 'interval', alias: 'i', type: Number, defaultValue: 1},
	{ name: 'mqtthost', alias: 'm', type: String, defaultValue: "localhost" },
	{ name: 'mqttclientid', alias: 'I', type: String, defaultValue: "heizstab" },
	{ name: 'mqttagg', alias: 'a', type: String, defaultValue: "agg/stb" },
	{ name: 'mqtttasmota', alias: 't', type: String,  defaultValue: "tasmota_FD6384"},
	{ name: 'mqttheatermeter', alias: 'M', type: String,  defaultValue: "SM-DRT/HS"},
	{ name: 'mqttheatermeterpower', alias: 'p', type: String,  defaultValue: "TotalActivePower"},
	{ name: 'mqttheater', alias: 'f', type: String,  defaultValue: "eta/192.168.10.99"}, 
	{ name: 'mqttwatertemp', alias: 'T', type: String,  defaultValue:"/112/10111/0/0/12271/Warmwasserspeicher"},
	{ name: 'mqttssrtemp', alias: 'r', type: String,  defaultValue:"DS18B20"},
	{ name: 'heatstart', alias: 's', type: Number,  defaultValue: 35.0},
	{ name: 'heatstop', alias: 'S', type: Number,  defaultValue: 47.0},
	{ name: 'window', alias: 'w', type: Number,  defaultValue: 10},
	{ name: 'debug', alias: 'd', type: Boolean,  defaultValue: false}
  ];

const options = commandLineArgs(optionDefinitions)
const powerArray=[[0,0],[5,300],[10,600],[15,900],[20,1200],[25,1500],[30,1800],[35,2100],[40,2400],[45,2700],
		[50,3000],[55,3300],[60,3600],[65,3900],[70,4200],[75,4500],[80,4800],[85,5100],[90,5400],
		[95,5700],[100,6000]];

var ewma = new EWMA(options.window*1000);
var last_agg = 0;
var last_tasmota = 0;
var power_real = 0;
var ssr_temp = 0;
var percent_set = 0;
var heating_done = false;
var water_temp = 0;
var system_op_status = 0;
var battery_power = 0;
var force_heating = false;

console.log("MQTT host           : " + options.mqtthost);
console.log("MQTT Client ID      : " + options.mqttclientid);
console.log("MQTT Agg-Topic      : " + options.mqttagg);
console.log("MQTT Tasmota-Topic  : " + options.mqtttasmota);
console.log("MQTT Heater-Meter   : " + options.mqttheatermeter);
console.log("MQTT Htr-Meter-Power: " + options.mqttheatermeterpower);
console.log("MQTT Heater-Topic   : " + options.mqttheater);
console.log("MQTT Watertemp-Var  : " + options.mqttwatertemp);
console.log("MQTT SSR-temp-Var   : " + options.mqttssrtemp);
console.log("Start heating       : " + options.heatstart);
console.log("Stop heating        : " + options.heatstop);
console.log("Smoothing Window (s): " + options.window);
console.log("Interval (s)        : " + options.interval);

function findVal(object, key) {
  var value;
  Object.keys(object).some(function (k) {
    if (k === key) {
      value = object[k];
      return true;
    }
    if (object[k] && typeof object[k] === 'object') {
      value = findVal(object[k], key);
      return value !== undefined;
    }
  });
  return value;
}

function power2percent(array, power) {
  for (let i = 0; i < array.length; i++) {
  	const pwr = array[i][1];
  	if(pwr>power) {
  		if(i == 0) {
  			return 0;
		}
		return array[i-1][0];
  	}
  }
  return 100;
}

async function tasmotaCommand(cmd, val) {
	val = val.toString();
	if(options.debug) { console.log("tasmotaCommand: " + cmd + " val: " + val);}
	MQTTclient.publish("cmnd/" + options.mqtttasmota + "/" + cmd, val);
}

function setPWM(percent) {
	percent=parseInt(percent);
	tasmotaCommand("Dimmer", percent);
}

function setpwmfrequency(value) {
	tasmotaCommand("PWMFrequency", value);
}

var MQTTclient = mqtt.connect("mqtt://"+options.mqtthost);
	MQTTclient.on("connect",function(){
	if(options.debug){ console.log("MQTT connected");}
})

MQTTclient.on("error",function(error){
		console.log("Can't connect" + error);
		process.exit(1)
	});

MQTTclient.subscribe(options.mqttagg);
MQTTclient.subscribe("tele/"+options.mqtttasmota+"/SENSOR");
MQTTclient.subscribe(options.mqttheatermeter);
MQTTclient.subscribe(options.mqttheater);
MQTTclient.subscribe("ehz2heizstab/#");

MQTTclient.on('message',function(topic, message, packet){
	if(topic.includes(options.mqttagg) ) {
		var obj=JSON.parse(message);
		var val = obj.gridBalance;
		ewma.insert(val);
		battery_power = obj.totalBatteryPower
		if(options.debug){ console.log("gridBalance: " + val + " battery_power: " + battery_power);}
		last_agg = Date.now();
	} else if(topic.includes(options.mqtttasmota)) {
		var obj=JSON.parse(message);
		var found = findVal(obj, options.mqttssrtemp);
		if(found) {
			ssr_temp = found.Temperature;
		}
		found = findVal(obj, options.mqttwatertemp);
		if(found) {
			water_temp = found.Temperature;
		}
		found = findVal(obj, options.mqttheatermeterpower);
		if(found) {
			power_real = found;
		}
		last_tasmota = Date.now();
		if(options.debug){ 
			console.log(util.inspect(obj));
			console.log("SSR-Temperature: " + ssr_temp);
			console.log("Water-Temperature: " + water_temp);
			console.log("Heater-Power:: " + power_real);
		}
	} else if(topic.includes(options.mqttheatermeter)) {
		var obj=JSON.parse(message);
		power_real = obj[options.mqttheatermeterpower] * 1000;
		if(options.debug){ console.log("power_real: " + power_real);}
	} else if(topic.includes(options.mqttheater)) {
		var obj=JSON.parse(message);
		var found = findVal(obj, options.mqttwatertemp);
		if(found) {
			water_temp = found;
			if(options.debug){ console.log("water_temp: " + water_temp);}
		}
	} else if(topic.includes("ehz2heizstab")) {
		var obj=JSON.parse(message);
		force_heating = obj["force_heating"];
		if(options.debug){ console.log("force_heating: " + force_heating);}
		heating_done = false;
	}
});


tasmotaCommand("pwmfrequency", 10);

async function loop() {
	if(ewma.value()) {
		const power_available = -ewma.value();
		const max_percent = power2percent(powerArray, power_available + power_real);
		if(Date.now()-last_tasmota > 60000 || Date.now()-last_agg > 60000) {
			console.log("stale data (MQTT)");
			await setPWM(0);
		} else if(heating_done && water_temp > options.heatstart) {
			await setPWM(0);
		} else if(!heating_done && water_temp >= options.heatstop) {
			await setPWM(0);
			heating_done = true;
			force_heating = false;
		} else {
			heating_done =false;
			if(options.debug){ console.log("force_heating: " + force_heating + " heating_done: " + heating_done + " power_available: " + parseInt(power_available) + " / power_real: " + power_real, "/ max_percent: " + max_percent);}
			if(force_heating) {
				percent_set = 100;
			} else {
				if(power_available > 500) {
					percent_set += power_available/200;
				} else if(power_available < 0) {
					percent_set -= 10;
				}
				if(percent_set > 100) {
					percent_set = 100;
				}
				if(power_available < 6000.0 && power_real < 100.0 && percent_set == 100) {
					percent_set = max_percent;
				}
				if(battery_power > 100) {
					percent_set = 0;
				}
			}
			if(percent_set < 5 || ssr_temp >= 60) {
				percent_set = 0;
			}
			await setPWM(percent_set);
		}
	}
	setTimeout(loop, options.interval*1000);
}

loop();
