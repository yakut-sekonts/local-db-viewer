"""Publish the verified catalog in a separate branch, without an application release."""
import base64
import json
import os
from pathlib import Path
import subprocess

repository = os.environ['GITHUB_REPOSITORY']
if len(repository.split('/')) != 2 or any(not part or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.' for c in part) for part in repository.split('/')):
    raise ValueError('Invalid GitHub repository')
gh = os.environ.get('GH_BIN', 'gh')

def api(method, path, body=None, optional=False):
    command = [gh, 'api', '--method', method, f'repos/{repository}/{path}']
    if body is not None: command += ['--input', '-']
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None, text=True, capture_output=True)
    if result.returncode:
        if optional and 'HTTP 404' in result.stderr: return None
        raise RuntimeError('GitHub catalog publication failed: ' + result.stderr[-1000:])
    return json.loads(result.stdout)

content = Path('drivers/catalog-lock.json').read_bytes()
catalog = json.loads(content)
if catalog.get('format') != 1 or not catalog.get('drivers'):
    raise ValueError('Invalid driver catalog')
branch = api('GET', 'git/ref/heads/driver-catalog', optional=True)
if branch is None:
    blob = api('POST', 'git/blobs', {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
    tree = api('POST', 'git/trees', {'tree': [{'path': 'catalog.json', 'mode': '100644', 'type': 'blob', 'sha': blob['sha']}]})
    commit = api('POST', 'git/commits', {'message': 'Publish verified JDBC driver catalog', 'tree': tree['sha'], 'parents': []})
    api('POST', 'git/refs', {'ref': 'refs/heads/driver-catalog', 'sha': commit['sha']})
    print('Published initial verified JDBC catalog')
else:
    previous = api('GET', 'contents/catalog.json?ref=driver-catalog', optional=True)
    if previous and json.loads(base64.b64decode(previous['content'])) == catalog:
        print('Catalog unchanged')
    else:
        api('PUT', 'contents/catalog.json', {'branch': 'driver-catalog', 'message': 'Update verified JDBC driver versions', 'content': base64.b64encode(content).decode(), **({'sha': previous['sha']} if previous else {})})
        print('Published updated verified JDBC catalog')
