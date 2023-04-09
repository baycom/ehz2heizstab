const util=require('util');
const mqtt=require('mqtt');
const request = require('request');
const EWMA = require('ewma');

const commandLineArgs = require('command-line-args')

const optionDefinitions = [
	{ name: 'interval', alias: 'i', type: Number, defaultValue: 10},
	{ name: 'mqtthost', alias: 'm', type: String, defaultValue: "localhost" },
	{ name: 'mqttclientid', alias: ' ', type: String, defaultValue: "ehz2heizstabMQTT" },
	{ name: 'mqttvzlogger', alias: 'v', type: String, defaultValue: "vzlogger/data/chn4/raw" },
	{ name: 'tasmotahost', alias: 'h', type: String, defaultValue: "http://tasmota-FD6384-0900" },
	{ name: 'mqtttasmota', alias: 't', type: String,  defaultValue: "tasmota_FD6384"},
	{ name: 'window', alias: 'w', type: Number,  defaultValue: 10},
	{ name: 'debug', alias: 'd', type: Boolean,  defaultValue: false}
  ];

const options = commandLineArgs(optionDefinitions)

var ewma = new EWMA(options.window*1000);
var power_real = 0;
var ssr_temp = 0;

console.log("MQTT host           : " + options.mqtthost);
console.log("MQTT Client ID      : " + options.mqttclientid);
console.log("MQTT VZLogger-Topic : " + options.mqttvzlogger);
console.log("MQTT Tasmota-Topic  : " + options.mqtttasmota);
console.log("Tasmota Host        : " + options.tasmotahost);
console.log("Smoothing Window (s): " + options.window);
console.log("Interval (s)        : " + options.interval);



function wget(url) {
    return new Promise((resolve, reject) => {
        request(url, { json: true }, (error, response, body) => {
            if (error) reject(error);
            if (response === undefined || response.statusCode === undefined ||  response.statusCode != 200) {
                reject('Invalid status code <');
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
if(options.debug){ console.log("tele/" + options.mqtttasmota + "/SENSOR");}

MQTTclient.on('message',function(topic, message, packet){
//	console.log(topic);
	if(topic.includes(options.mqttvzlogger) ) {
		var val=parseFloat(message.toString());
		ewma.insert(val);
	} else if(topic.includes(options.mqtttasmota)) {
		var obj=JSON.parse(message);
		power_real = obj.HS.power_total;
		ssr_temp = obj.DS18B20.Temperature;
		if(options.debug){ console.log("power_real: " + power_real + " SSR-Temperature: " + ssr_temp);}
	}
});


tasmotaCommand("pwmfrequency", 10);

async function loop() {
	var power_set = parseInt(-ewma.value() + power_real);
	if(options.debug){ console.log("ewma: " + -parseInt(ewma.value()) + "+ power_real: " + power_real + " = " + power_set);}
	if(power_set > 500 && ssr_temp < 60) {
		if(power_set > 6000) {
			power_set = 6000;
		}
		var percent = parseInt(power_set*50 / 6000)+50;
		await setPWM(percent);
	} else {
		await setPWM(0);
	}
	setTimeout(loop, options.interval*1000);
}

loop();
