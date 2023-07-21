const util=require('util');
const mqtt=require('mqtt');
const request = require('request');
const EWMA = require('ewma');
const interpolateArrays = require('interpolate-arrays')
const commandLineArgs = require('command-line-args')

const optionDefinitions = [
	{ name: 'interval', alias: 'i', type: Number, defaultValue: 10},
	{ name: 'mqtthost', alias: 'm', type: String, defaultValue: "localhost" },
	{ name: 'mqttclientid', alias: 'I', type: String, defaultValue: "ehz2heizstabMQTT" },
	{ name: 'mqttvzlogger', alias: 'v', type: String, defaultValue: "vzlogger/data/chn4/raw" },
	{ name: 'tasmotahost', alias: 'h', type: String, defaultValue: "http://tasmota-FD6384-0900" },
	{ name: 'mqtttasmota', alias: 't', type: String,  defaultValue: "tasmota_FD6384"},
	{ name: 'mqttheater', alias: 'f', type: String,  defaultValue: "eta/192.168.10.99"}, 
	{ name: 'mqttwatertemp', alias: 'T', type: String,  defaultValue:"/112/10111/0/0/12271/Warmwasserspeicher"},
	{ name: 'mqttsysopstatus', alias: 'o', type: String,  defaultValue:"Batrium/4538/3233"},
	{ name: 'mqttbatterypower', alias: 'b', type: String,  defaultValue:"GoodWe/9010KETU224W0868"},
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
var last_vzlogger = 0;
var last_tasmota = 0;
var power_real = 0;
var ssr_temp = 0;
var percent_set = 0;
var heating_done = false;
var water_temp = 0;
var system_op_status = 0;
var battery_power = 0;

console.log("MQTT host           : " + options.mqtthost);
console.log("MQTT Client ID      : " + options.mqttclientid);
console.log("MQTT VZLogger-Topic : " + options.mqttvzlogger);
console.log("MQTT Tasmota-Topic  : " + options.mqtttasmota);
console.log("MQTT Heater-Topic   : " + options.mqttheater);
console.log("MQTT Watertemp-Var  : " + options.mqttwatertemp);
console.log("MQTT SystemOpStatus : " + options.mqttsysopstatus);
console.log("MQTT BatteryPower   : " + options.mqttbatterypower);
console.log("Start heating       : " + options.heatstart);
console.log("Stop heating        : " + options.heatstop);
console.log("Tasmota Host        : " + options.tasmotahost);
console.log("Smoothing Window (s): " + options.window);
console.log("Interval (s)        : " + options.interval);

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

function wget(url) {
    return new Promise((resolve, reject) => {
        request(url, { json: true }, (error, response, body) => {
            if (error) reject(error);
            if (response === undefined || response.statusCode === undefined ||  response.statusCode != 200) {
                reject('Invalid status code');
            }
            resolve(body);
        });
    });
}


async function tasmotaCommand(cmd, val) {
	try {
		if(options.debug) { console.log("tasmotaCommand: "+cmd+" val: "+val);}
		const body= await wget(options.tasmotahost+"/cm?cmnd="+cmd+"%20"+val);
		if(options.debug) { console.log("body: "+ util.inspect(body));}
	} catch (error) {
        	console.error('ERROR:');
        	console.error(error);
	}
}

function setPWM(percent) {
	percent=parseInt(percent);
	tasmotaCommand("Dimmer", percent);
}

function setpwmfrequency(value) {
	tasmotaCommand("pwmfrequency", value);
}

var MQTTclient = mqtt.connect("mqtt://"+options.mqtthost,{clientId: options.mqttclientid});
	MQTTclient.on("connect",function(){
	if(options.debug){ console.log("MQTT connected");}
})

MQTTclient.on("error",function(error){
		console.log("Can't connect" + error);
		process.exit(1)
	});

MQTTclient.subscribe(options.mqttvzlogger);
MQTTclient.subscribe("tele/" + options.mqtttasmota + "/SENSOR");
MQTTclient.subscribe(options.mqttheater);
MQTTclient.subscribe(options.mqttsysopstatus);
MQTTclient.subscribe(options.mqttbatterypower);

if(options.debug){ console.log("tele/" + options.mqtttasmota + "/SENSOR");}

MQTTclient.on('message',function(topic, message, packet){
//	console.log(topic);
	if(topic.includes(options.mqttvzlogger) ) {
		var val=parseFloat(message.toString());
		ewma.insert(val);
		last_vzlogger = Date.now();
	} else if(topic.includes(options.mqtttasmota)) {
		var obj=JSON.parse(message);
		power_real = obj.HS.power_total;
		ssr_temp = obj.DS18B20.Temperature;
		last_tasmota = Date.now();
		if(options.debug){ console.log("power_real: " + power_real + " SSR-Temperature: " + ssr_temp);}
	} else if(topic.includes(options.mqttheater)) {
		var obj=JSON.parse(message);
		water_temp = obj[options.mqttwatertemp];
		if(options.debug){ console.log("water_temp: " + water_temp);}
	} else if(topic.includes(options.mqttsysopstatus)) {
		var obj=JSON.parse(message);
		system_op_status = obj["SystemOpStatus"];
		if(options.debug){ console.log("system_op_status: " + system_op_status);}
	} else if(topic.includes(options.mqttbatterypower)) {
		var obj=JSON.parse(message);
		battery_power = obj["BatteryPower"];
		if(options.debug){ console.log("battery_power: " + battery_power);}
	}
});


tasmotaCommand("pwmfrequency", 10);

async function loop() {
	if(ewma.value()) {
		const power_available = -ewma.value();
		const max_percent = power2percent(powerArray, power_available + power_real + battery_power);
		if(Date.now()-last_tasmota > 60000 || Date.now()-last_vzlogger > 60000) {
			console.log("stale data (MQTT)");
			await setPWM(0);
		} else if(heating_done && water_temp > options.heatstart) {
			await setPWM(0);
		} else if(!heating_done && water_temp >= options.heatstop) {
			await setPWM(0);
			heating_done = true;
		} else {
			heating_done =false;
			if(options.debug){ console.log("heating_done: " + heating_done + " power_available: " + parseInt(power_available) + " / power_real: " + power_real, "/ max_percent: " + max_percent);}
			if(power_available > 500) {
				if(percent_set < 40) {
					percent_set = 40;
				}
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
			if(percent_set < 5 || ssr_temp >= 60) {
				percent_set = 0;
			}
			if(system_op_status != 1 && system_op_status != 5) {
				percent_set = 0;
			}
			await setPWM(percent_set);
		}
	}
	setTimeout(loop, options.interval*1000);
}

loop();
