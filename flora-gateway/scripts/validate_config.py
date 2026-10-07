"""Offline config validation. Usage: python scripts/validate_config.py CONFIG SEED."""
import argparse
import ipaddress
import json
from pathlib import Path
import sys
import tomllib

GATEWAY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GATEWAY / 'python/device-medical-service'))
from device_medical_service.parsers import load_parser


def validate(config, instances, catalog):
    pods = {}
    serial_paths = set()
    listeners = set()
    for section in ('serial','socket','feeder','webhook'):
        for pod in config.get(section,{}).get('pods',[]):
            key=f'{section}.{pod["id"]}'
            if key in pods:
                raise ValueError(f'duplicate pod {key}')
            pods[key]=pod
            enabled=pod.get('enabled',True)
            if section=='serial':
                if pod.get('parity','none') not in ('none','even','odd') or pod.get('data_bits',8) not in (7,8) or pod.get('stop_bits',1) not in (1,2):
                    raise ValueError(f'invalid serial settings for {key}')
                if pod.get('flow_control','none') not in ('none','hardware','software'):
                    raise ValueError(f'invalid serial flow_control for {key}')
                if pod.get('baud',9600)<=0:
                    raise ValueError(f'invalid baud for {key}')
                path=pod['path'].upper() if pod['path'].upper().startswith('COM') else pod['path']
                if enabled:
                    if not path or path in serial_paths:
                        raise ValueError(f'serial path empty or assigned twice: {path}')
                    serial_paths.add(path)
            if section=='socket':
                transport=pod.get('transport','tcp')
                if transport not in ('tcp','udp'):
                    raise ValueError(f'invalid transport for {key}')
                if pod.get('framing','mllp') not in ('mllp','line','idle','raw','udp_relay'):
                    raise ValueError(f'invalid framing for {key}')
                if pod.get('remote_host') and transport!='tcp':
                    raise ValueError(f'remote_host requires TCP: {key}')
                if not 0<=pod['port']<=65535 or (enabled and not pod['port']):
                    raise ValueError(f'configure a real port for {key}')
                for address in pod.get('source_ips',[]): ipaddress.ip_address(address)
                ipaddress.IPv4Address(pod.get('multicast_interface','0.0.0.0'))
                for group in pod.get('multicast_groups',[]):
                    if not ipaddress.IPv4Address(group).is_multicast:
                        raise ValueError(f'invalid multicast group for {key}')
                discovery=pod.get('discovery')
                if discovery:
                    if not ipaddress.IPv4Address(discovery['group']).is_multicast or not 0<int(discovery['port'])<65536:
                        raise ValueError(f'invalid discovery group or port for {key}')
                    if not ipaddress.IPv4Address(discovery.get('data_group_base','224.0.1.0')).is_multicast:
                        raise ValueError(f'invalid discovery data_group_base for {key}')
                if enabled and not pod.get('remote_host'):
                    listener=(transport,pod.get('bind_address','0.0.0.0'),pod['port'])
                    if listener in listeners: raise ValueError(f'duplicate listener: {key}')
                    listeners.add(listener)
    types={row['code']:row for row in catalog['device_types']}
    ids=set()
    active_pods=set()
    for item in instances:
        device=item['device_id']
        if device in ids: raise ValueError(f'duplicate device_id: {device}')
        ids.add(device)
        kind=types[item['device_type']]
        pod=pods[item['pod']]
        if item['pod'].split('.')[0]!=kind['controller']:
            raise ValueError(f'wrong controller for {device}')
        options={**kind.get('default_options',{}),**item.get('options',{})}
        load_parser(kind['parser'],device,item['pod'],options)
        if options.get('source_ip') and pod.get('source_ips') and options['source_ip'] not in pod['source_ips']:
            raise ValueError(f'source_ip not allowed by pod for {device}')
        if item.get('enabled',True):
            if not pod.get('enabled',True): raise ValueError(f'enabled device uses a disabled pod: {device}')
            # Active request protocols own their connection, including one BCC pump address.
            if kind['parser'] in {'ge_carestation','ge_dri','bbraun_bcc','medibus','ascii_kv'}:
                if item['pod'] in active_pods: raise ValueError(f'multiple command-producing instances share {item["pod"]}')
                active_pods.add(item['pod'])
    return len(pods),len(ids)


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('config',type=Path)
    cli.add_argument('instances',type=Path)
    args=cli.parse_args()
    try:
        config=tomllib.loads(args.config.read_text(encoding='utf-8'))
        instances=json.loads(args.instances.read_text(encoding='utf-8'))
        catalog=json.loads((GATEWAY.parent/'flora-canopy/haber/app/catalog.json').read_text(encoding='utf-8'))
        pods,devices=validate(config,instances,catalog)
    except (ValueError,KeyError,OSError,TypeError) as error:
        cli.exit(1,f'Configuration error: {error}\n')
    print(f'Valid configuration: {pods} pods, {devices} device instances. No hardware was contacted.')


if __name__=='__main__': main()
